import * as XLSX from "xlsx";
import { PackingListScanResult, PackingListItem, normalizeDepartment } from "../types";

/**
 * Parses an Excel or CSV file into a PackingListScanResult structure.
 */
export async function parseExcelPackingList(file: File): Promise<PackingListScanResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        if (!data) {
          throw new Error("Could not read file data.");
        }

        const workbook = XLSX.read(data, { type: "array" });
        
        // Target list of worksheets to look for in the user's excel workbook
        const targetSheetTitles = ["sghc food", "sghc non-food", "sghc broc items"];
        
        // Find worksheets in the uploaded file that match our targets (case insensitive, contains match)
        const sheetsToProcess = workbook.SheetNames.filter(name => {
          const lower = name.trim().toLowerCase();
          return targetSheetTitles.some(target => lower === target || lower.includes(target));
        });

        // Fallback to the first sheet in the workbook if no target sheets were found
        const finalSheetsList = sheetsToProcess.length > 0 ? sheetsToProcess : [workbook.SheetNames[0]];

        let compiledItems: PackingListItem[] = [];
        let globalSupplier = "";
        let globalVoyage = "";
        let globalPropertyRemarks = "";
        let globalPRRef = "";
        let globalChargingDept = "";
        let globalPRDateReceived = "";
        let globalPRDateSend = "";
        let globalReceivedDate = "";
        let currentDepartment = "";

        for (const sheetName of finalSheetsList) {
          const worksheet = workbook.Sheets[sheetName];
          if (!worksheet) continue;

          // Normalize/standardize the worksheet name to match our active target sheet categories
          let standardizedSheetName = sheetName;
          const lowerSheet = sheetName.trim().toLowerCase();
          if (lowerSheet.includes("food") && !lowerSheet.includes("non-food")) {
            standardizedSheetName = "SGHC FOOD";
          } else if (lowerSheet.includes("non-food") || lowerSheet.includes("non food")) {
            standardizedSheetName = "SGHC NON-FOOD";
          } else if (lowerSheet.includes("broc")) {
            standardizedSheetName = "SGHC BROC ITEMS";
          }

          // Convert worksheet to 2D array
          const rawRows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1 });
          if (rawRows.length === 0) continue;

          // 1. Search for headers
          let headerIdx = -1;
          let descColIdx = -1;
          let qtyColIdx = -1;
          let uomColIdx = -1;

          for (let r = 0; r < Math.min(rawRows.length, 30); r++) {
            const row = rawRows[r];
            if (!Array.isArray(row)) continue;

            for (let c = 0; c < row.length; c++) {
              const val = String(row[c] || "").trim().toLowerCase();

              if (
                val.includes("description") || 
                val.includes("product") || 
                val.includes("item") || 
                val.includes("particular") || 
                val.includes("material") ||
                val === "desc"
              ) {
                descColIdx = c;
              }
              if (
                val.includes("qty") || 
                val.includes("quantity") || 
                val.includes("received") || 
                val.includes("delivered") || 
                val.includes("amount") ||
                val.includes("pcs") ||
                val === "received qty"
              ) {
                qtyColIdx = c;
              }
              if (
                val.includes("uom") || 
                val.includes("unit") || 
                val.includes("pkg") || 
                val.includes("measure") ||
                val.includes("pack")
              ) {
                uomColIdx = c;
              }
            }

            if (descColIdx !== -1 && qtyColIdx !== -1) {
              headerIdx = r;
              break;
            }
          }

          // 2. Fallback heuristic if headers not explicitly detected
          if (descColIdx === -1 || qtyColIdx === -1) {
            let candidateDesc = -1;
            let candidateQty = -1;
            let candidateUom = -1;

            for (let r = 0; r < Math.min(rawRows.length, 15); r++) {
              const row = rawRows[r];
              if (!Array.isArray(row)) continue;

              for (let c = 0; c < row.length; c++) {
                const val = row[c];
                if (typeof val === "number" && !isNaN(val) && val > 0 && candidateQty === -1) {
                  candidateQty = c;
                } else if (typeof val === "string" && val.trim().length > 3 && candidateDesc === -1) {
                  const clean = val.trim().toLowerCase();
                  if (
                    !clean.includes("invoice") && 
                    !clean.includes("supplier") && 
                    !clean.includes("order") &&
                    !clean.includes("packing") &&
                    !clean.includes("sheet")
                  ) {
                    candidateDesc = c;
                  }
                } else if (typeof val === "string" && val.trim().length > 0 && val.trim().length < 5 && candidateUom === -1) {
                  const clean = val.trim().toLowerCase();
                  if (clean === "pcs" || clean === "box" || clean === "bags" || clean === "unit" || clean === "pack") {
                    candidateUom = c;
                  }
                }
              }
            }

            if (candidateDesc !== -1) descColIdx = candidateDesc;
            if (candidateQty !== -1) qtyColIdx = candidateQty;
            if (candidateUom !== -1) uomColIdx = candidateUom;
          }

          // Force basic defaults if headers still missing
          if (descColIdx === -1) descColIdx = 0;
          if (qtyColIdx === -1) qtyColIdx = 1;

          // 3. Extract Metadata (prefer first found or combined)
          for (let r = 0; r < Math.min(rawRows.length, 15); r++) {
            const row = rawRows[r];
            if (!Array.isArray(row)) continue;

            for (let c = 0; c < row.length; c++) {
              const val = String(row[c] || "").trim();
              const valLower = val.toLowerCase();

              if (valLower.includes("supplier") || valLower.includes("vendor") || valLower.includes("sent by")) {
                const nextVal = String(row[c + 1] || "").trim();
                const tempSup = nextVal ? nextVal : val;
                const cleanedSup = tempSup.replace(/^(supplier|vendor|sent by)[:\- ]+/i, "").trim();
                if (!globalSupplier) globalSupplier = cleanedSup;
              }
              if (valLower.includes("voyage") || valLower.includes("vessel") || valLower.includes("travel")) {
                const nextVal = String(row[c + 1] || "").trim();
                const tempVoy = nextVal ? nextVal : val;
                const cleanedVoy = tempVoy.replace(/^(voyage|vessel|travel)[:\- ]+/i, "").trim();
                if (!globalVoyage && cleanedVoy.length > 2) globalVoyage = cleanedVoy;
              }
              if (valLower.includes("delivery date") || (valLower.includes("date") && !valLower.includes("pr") && !valLower.includes("received") && !valLower.includes("send"))) {
                const nextVal = String(row[c + 1] || "").trim();
                if (!globalReceivedDate) globalReceivedDate = nextVal || val;
              }
              if (valLower.includes("remark") || valLower.includes("note") || valLower.includes("comment")) {
                const nextVal = String(row[c + 1] || "").trim();
                const tempRem = nextVal ? nextVal : val;
                const cleanedRem = tempRem.replace(/^(remark|remarks|note|comment)[:\- ]+/i, "").trim();
                if (!globalPropertyRemarks) globalPropertyRemarks = cleanedRem;
              }
              if (valLower.includes("purchase request") || valLower.includes("pr ref") || valLower.includes("serial ref")) {
                const nextVal = String(row[c + 1] || "").trim();
                const cleanedRef = (nextVal || val).replace(/^(purchase request|pr ref|serial ref|reference)[:\- ]+/i, "").trim();
                if (!globalPRRef) globalPRRef = cleanedRef;
              }
              if (valLower.includes("charging") || (valLower.includes("department") && !valLower.includes("uom"))) {
                const nextVal = String(row[c + 1] || "").trim();
                const cleanedDept = (nextVal || val).replace(/^(department|dept|charging department)[:\- ]+/i, "").trim();
                if (!globalChargingDept) globalChargingDept = cleanedDept;
              }
              if (valLower.includes("pr date received") || valLower.includes("date received")) {
                const nextVal = String(row[c + 1] || "").trim();
                if (!globalPRDateReceived) globalPRDateReceived = nextVal || val;
              }
              if (valLower.includes("pr date send") || valLower.includes("date send")) {
                const nextVal = String(row[c + 1] || "").trim();
                if (!globalPRDateSend) globalPRDateSend = nextVal || val;
              }
            }
          }

          // 4. Extract Items from this Excel sheet
          const startRow = headerIdx !== -1 ? headerIdx + 1 : 0;
          for (let r = startRow; r < rawRows.length; r++) {
            const row = rawRows[r];
            if (!Array.isArray(row)) continue;
            if (r === headerIdx) continue;

            const desc = String(row[descColIdx] || "").trim();
            
            // Check if row is a department header
            const rowStr = row.join(" ").toUpperCase();
            if (rowStr.includes("SGHC-")) {
              const fullDept = rowStr.match(/SGHC-[A-Z0-9\s-]+/i)?.[0].trim() || currentDepartment;
              currentDepartment = normalizeDepartment(fullDept);
              continue;
            }
            
            const qtyRaw = row[qtyColIdx];
            const uom = uomColIdx !== -1 ? String(row[uomColIdx] || "").trim() : "pcs";

            if (!desc || desc.length < 2) continue;
            if (desc.toLowerCase().includes("total") || desc.toLowerCase().includes("page")) continue;

            let qtyVal = 0;
            if (typeof qtyRaw === "number") {
              qtyVal = qtyRaw;
            } else if (qtyRaw !== undefined && qtyRaw !== null && qtyRaw !== "") {
              qtyVal = parseFloat(String(qtyRaw).replace(/[^\d.-]/g, "")) || 0;
            }

            if (qtyVal <= 0) {
              qtyVal = 1;
            }

            compiledItems.push({
              description: desc,
              quantityReceived: qtyVal,
              uom: uom || "pcs",
              sheetName: standardizedSheetName,
              department: currentDepartment,
            });
          }
        }

        resolve({
          supplier: globalSupplier || "",
          voyage: globalVoyage || "",
          propertyRemarks: globalPropertyRemarks || "",
          receivedDate: globalReceivedDate || "",
          purchaseRequestRef: globalPRRef || "",
          chargingDepartment: globalChargingDept || "",
          prDateReceived: globalPRDateReceived || "",
          prDateSend: globalPRDateSend || "",
          items: compiledItems,
        });

      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = (err) => reject(new Error("File reading error: " + err));
    reader.readAsArrayBuffer(file);
  });
}
