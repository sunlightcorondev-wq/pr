import React, { useState, useRef, useEffect } from "react";
import { Upload, Camera, FileCheck, CheckCircle2, AlertTriangle, AlertCircle, RefreshCw, Layers, Edit3, HelpCircle, Save, ArrowRight, User, Play, X, Search, Share2, Copy, Loader2, Hash, Percent } from "lucide-react";
import { PackingListScanResult, PackingListItem, PackingListMatch, SheetRow, MatchCandidate, KITCHEN_DEPARTMENTS, normalizeDepartment } from "../types";
import { fetchSpreadsheetRows, updateSpreadsheetRow, batchUpdateSpreadsheetRows, copyFileToNewOwner } from "../googleSheetsService";
import { compressImage } from "../utils/imageCompressor";
import { parseExcelPackingList } from "../utils/excelParser";

interface PackingListScannerProps {
  accessToken: string;
  spreadsheetId: string;
  onSuccess: () => void;
}

interface QueueFileItem {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  preview: string | null;
  status: "pending" | "compressing" | "scanning" | "done" | "error";
  error: string | null;
  isExcel: boolean;
  result?: PackingListScanResult;
}

// Improved similarity with type penalty
function calculateSimilarity(str1: string, str2: string): number {
  const s1Raw = (str1 || "").toLowerCase().trim();
  const s2Raw = (str2 || "").toLowerCase().trim();
  if (s1Raw === s2Raw) return 1.0;
  if (!s1Raw || !s2Raw) return 0.0;

  // Unit and plural normalization
  const normalize = (s: string) => {
    return s
      .replace(/\bkg\b|\bkgs\b/g, "kg")
      .replace(/\blb\b|\blbs\b/g, "lb")
      .replace(/\bcase\b|\bcases\b/g, "cs")
      .replace(/\btank\b|\btanks\b/g, "tank")
      .replace(/\bpack\b|\bpacks\b|\bpk\b/g, "pk")
      .replace(/\bpail\b|\bpails\b/g, "pail")
      .replace(/(\d+)(kg|lb|cs|pk|tank|pail|pc|ea|unit)/g, "$1 $2") // Split numbers from common units
      .replace(/[^a-z0-9]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const s1 = normalize(s1Raw);
  const s2 = normalize(s2Raw);

  // Identify product category/type keywords
  const typeKeywords = [
    "ketchup", "paste", "sauce", "mustard", "mayonnaise", 
    "meat", "beef", "chicken", "pork", "fish", "shrimp", "squid",
    "rice", "flour", "oil", "juice", "vinegar", "sugar", "salt",
    "bacon", "broth", "cube", "pineapple", "coffee", "stirrer", "straw",
    "seasoning", "water", "coke", "sprite", "tea", "lpg", "gas", "wax",
    "muriatic", "dishwashing", "sponge", "detergent", "soap", "cleaner",
    "vinyl", "gloves", "bag", "box", "carton"
  ];
  
  const s1Types = typeKeywords.filter(t => s1.split(/\s+/).includes(t));
  const s2Types = typeKeywords.filter(t => s2.split(/\s+/).includes(t));
  
  // If both have identified types and they are explicitly different, penalize heavily
  if (s1Types.length > 0 && s2Types.length > 0) {
    const hasCommonType = s1Types.some(t => s2Types.includes(t));
    if (!hasCommonType) {
      return 0.05;
    }
  }

  // Tokenization
  const t1 = s1.split(/\s+/).filter(t => t.length >= 2 || /^\d+$/.test(t));
  const t2 = s2.split(/\s+/).filter(t => t.length >= 2 || /^\d+$/.test(t));

  if (t1.length === 0 || t2.length === 0) return 0.0;

  // 1. Token Overlap (Dice)
  let matchCount = 0;
  const t2Set = new Set(t2);
  t1.forEach((t) => {
    if (t2Set.has(t)) {
      matchCount++;
    }
  });
  const diceScore = (2 * matchCount) / (t1.length + t2.length);

  // 2. Number Conflict Check
  const nums1 = t1.filter(t => /^\d+$/.test(t));
  const nums2 = t2.filter(t => /^\d+$/.test(t));
  let numPenalty = 0;
  if (nums1.length > 0 && nums2.length > 0) {
    const hasNumMatch = nums1.some(n => nums2.includes(n));
    if (!hasNumMatch) {
      numPenalty = 0.15;
    }
  }

  // 3. Character Trigrams (for fuzzy word matches)
  const getTrigrams = (str: string) => {
    const tg = [];
    for (let i = 0; i < str.length - 2; i++) {
      tg.push(str.substring(i, i + 3));
    }
    return tg;
  };
  const tg1 = getTrigrams(s1);
  const tg2 = getTrigrams(s2);
  let tgMatch = 0;
  let tgScore = 0;
  if (tg1.length > 0 && tg2.length > 0) {
    const tg2Set = new Set(tg2);
    tg1.forEach(t => { if (tg2Set.has(t)) tgMatch++; });
    tgScore = (2 * tgMatch) / (tg1.length + tg2.length);
  }

  // Combine Scores
  const combinedBase = (diceScore * 0.7) + (tgScore * 0.3);
  
  // 4. First Word Bonus
  let bonus = 0;
  if (t1[0] === t2[0]) {
    bonus = 0.1;
  }

  return Math.max(0, Math.min(combinedBase + bonus - numPenalty, 1.0));
}

// Extraction helper for file name metadata
function extractMetadataFromFileName(fileName: string) {
  let voyage = "";
  let receivedDate = "";

  // Extract Voyage Number: Supports "VOYAGE #02", "VOYAGE # 6", etc.
  const voyageMatch = fileName.match(/VOYAGE\s*#\s*(\d+)/i);
  if (voyageMatch) {
    voyage = `Voyage #${voyageMatch[1]}`;
  }

  // Extract Dates (MM-DD-YY): Matches "(02-03-26 TO 02-09-26)" or "(06-08-26 to 06-10-26)"
  const dateRangeMatch = fileName.match(/(\d{2}-\d{2}-\d{2})\s*(?:TO|to)\s*(\d{2}-\d{2}-\d{2})/i);
  if (dateRangeMatch) {
    const lastDateStr = dateRangeMatch[2]; // e.g., "02-09-26"
    
    try {
      const parts = lastDateStr.split("-");
      const month = parseInt(parts[0], 10) - 1;
      const day = parseInt(parts[1], 10);
      let year = parseInt(parts[2], 10);
      
      // Handle 2-digit year (assuming 20xx)
      if (year < 100) year += 2000;
      
      const date = new Date(year, month, day);
      if (!isNaN(date.getTime())) {
        // ADD 2 DAYS as requested
        date.setDate(date.getDate() + 2);
        // Format as MM/DD/YYYY for Google Sheets compatibility
        receivedDate = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
      }
    } catch (e) {
      console.error("Error parsing date from file name:", e);
    }
  }

  return { voyage, receivedDate };
}

const FOOD_KEYWORDS = [
  "FOOD", "PROVISIONS", "GROCERIES", "MEAT", "BEEF", "CHICKEN", "PORK", "FISH", "SEAFOOD",
  "VEGETABLE", "FRUIT", "DAIRY", "MILK", "CHEESE", "BUTTER", "EGG", "BREAD", "BAKERY",
  "RICE", "GRAIN", "FLOUR", "SUGAR", "SALT", "SPICE", "SAUCE", "CONDIMENT",
  "BEVERAGE", "DRINK", "JUICE", "WATER", "COFFEE", "TEA", "SNACK", "CANDY", "CHOCOLATE",
  "PASTA", "NOODLE", "CEREAL", "FROZEN", "CANNED", "FRESH", "PRODUCE", "OIL", "FAT",
  "VINEGAR", "SYRUP", "JAM", "HONEY", "NUT", "SEED", "LEGUME", "BEAN", "LENTIL",
  "POULTRY", "STEAK", "FILLET", "SAUSAGE", "HAM", "BACON", "SALAMI", "TURKEY", "LAMB",
  "SHRIMP", "PRAWN", "CRAB", "LOBSTER", "OYSTER", "MUSSEL", "CLAM", "SQUID", "OCTOPUS",
  "POTATO", "ONION", "GARLIC", "TOMATO", "CARROT", "CUCUMBER", "LETTUCE", "SPINACH", "BROCCOLI",
  "CAULIFLOWER", "CABBAGE", "PEA", "CORN", "APPLE", "BANANA", "ORANGE", "GRAPE", "STRAWBERRY",
  "MELON", "PINEAPPLE", "MANGO", "PEACH", "PEAR", "PLUM", "BERRY", "LEMON", "LIME",
  "YOGURT", "CREAM", "SOUR CREAM", "MARGARINE", "TOFU", "TEMPEH", "SEITAN",
  "COKE", "PEPSI", "SODA", "BISCUIT", "COOKIE", "CAKE", "PIE", "PASTRY"
];

export function PackingListScanner({
  accessToken,
  spreadsheetId,
  onSuccess,
}: PackingListScannerProps) {
  const [queue, setQueue] = useState<QueueFileItem[]>([]);
  const [activeQueueIdx, setActiveQueueIdx] = useState<number>(-1);
  const [isScanning, setIsScanning] = useState(false);
  const [targetSheet, setTargetSheet] = useState<string>("ALL");
  const [scanResult, setScanResult] = useState<PackingListScanResult | null>(null);
  const [sheetRows, setSheetRows] = useState<SheetRow[]>([]);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);
  const [matches, setMatches] = useState<PackingListMatch[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // State for Transfer Ownership
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [transferEmail, setTransferEmail] = useState("");
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferTitle, setTransferTitle] = useState("");

  const [searchModalIndex, setSearchModalIndex] = useState<number | null>(null);
  const [rowSearchQuery, setRowSearchQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load Sheet Rows to cross-reference
  const loadSheetRows = async () => {
    if (!spreadsheetId) return;
    setIsLoadingSheet(true);
    try {
      if (targetSheet === "ALL") {
        const [purchasing, operations] = await Promise.all([
          fetchSpreadsheetRows(accessToken, spreadsheetId, "PURCHASING").catch(() => []),
          fetchSpreadsheetRows(accessToken, spreadsheetId, "OPERATIONS").catch(() => [])
        ]);
        setSheetRows([...purchasing, ...operations]);
      } else {
        const rows = await fetchSpreadsheetRows(accessToken, spreadsheetId, targetSheet);
        setSheetRows(rows);
      }
    } catch (err: any) {
      console.error("Error loading sheet rows for verify:", err);
      setError("Failed to load spreadsheet rows. Verify spreadsheet exists & is writable.");
    } finally {
      setIsLoadingSheet(false);
    }
  };

  useEffect(() => {
    loadSheetRows();
  }, [spreadsheetId, targetSheet]);

  // Compress a file and update the queue item if image preview needed
  const updateItemPreview = async (itemId: string, file: File, isExcel: boolean) => {
    if (isExcel) {
      setQueue((prev) =>
        prev.map((item) =>
          item.id === itemId
            ? { ...item, status: "pending", preview: "excel_loaded_placeholder" }
            : item
        )
      );
      return;
    }

    try {
      setQueue((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, status: "compressing" } : item))
      );
      const { dataUrl, mimeType: compressedMime } = await compressImage(file, 1280, 0.75);
      setQueue((prev) =>
        prev.map((item) =>
          item.id === itemId
            ? { ...item, status: "pending", preview: dataUrl, mimeType: compressedMime }
            : item
        )
      );
    } catch (err: any) {
      console.error(err);
      setQueue((prev) =>
        prev.map((item) =>
          item.id === itemId
            ? { ...item, status: "error", error: "Failed to load/compress document" }
            : item
        )
      );
    }
  };

  // Add selected files to the processing queue
  const addFilesToQueue = (files: FileList) => {
    setError(null);
    const validFiles = Array.from(files).filter((file) => {
      const isExcel =
        file.name.endsWith(".xlsx") ||
        file.name.endsWith(".xls") ||
        file.name.endsWith(".csv") ||
        file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        file.type === "application/vnd.ms-excel" ||
        file.type === "text/csv";
      return isExcel || file.type.startsWith("image/") || file.type === "application/pdf";
    });

    if (validFiles.length === 0) {
      setError("Please select valid Excel files (.xlsx, .xls, .csv), PDF files, or images.");
      return;
    }

    const newItems: QueueFileItem[] = validFiles.map((file, idx) => {
      const id = `${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 5)}`;
      const isExcel =
        file.name.endsWith(".xlsx") ||
        file.name.endsWith(".xls") ||
        file.name.endsWith(".csv") ||
        file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        file.type === "application/vnd.ms-excel" ||
        file.type === "text/csv";

      return {
        id,
        file,
        name: file.name,
        mimeType: file.type,
        preview: null,
        status: "pending",
        error: null,
        isExcel,
      };
    });

    const updatedQueue = [...queue, ...newItems];
    setQueue(updatedQueue);

    // Default select newly added item if nothing selected
    if (activeQueueIdx === -1) {
      setActiveQueueIdx(queue.length);
    }

    // Trigger preview loads
    newItems.forEach((item) => {
      updateItemPreview(item.id, item.file, item.isExcel);
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToQueue(e.target.files);
    }
  };

  const removeFromQueue = (idx: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const updated = queue.filter((_, i) => i !== idx);
    setQueue(updated);

    if (updated.length === 0) {
      setActiveQueueIdx(-1);
    } else if (activeQueueIdx >= updated.length) {
      setActiveQueueIdx(updated.length - 1);
    }
  };

  const startBatchScan = async () => {
    if (queue.length === 0) return;
    setIsScanning(true);
    setError(null);

    // Load fresh sheets rows again for real-time comparison matching
    let freshRows = sheetRows;
    try {
      if (targetSheet === "ALL") {
        const [purchasing, operations] = await Promise.all([
          fetchSpreadsheetRows(accessToken, spreadsheetId, "PURCHASING").catch(() => []),
          fetchSpreadsheetRows(accessToken, spreadsheetId, "OPERATIONS").catch(() => [])
        ]);
        freshRows = [...purchasing, ...operations];
      } else {
        freshRows = await fetchSpreadsheetRows(accessToken, spreadsheetId, targetSheet);
      }
      setSheetRows(freshRows);
    } catch (err) {
      console.error("Non-blocking refresh warning:", err);
    }

    let compiledResult: PackingListScanResult = {
      supplier: "",
      voyage: "",
      propertyRemarks: "",
      receivedDate: "",
      items: [],
    };

    let hadSuccess = false;

    // Pre-extract metadata from file names in the queue
    for (const item of queue) {
      const { voyage, receivedDate } = extractMetadataFromFileName(item.name);
      if (voyage && !compiledResult.voyage) compiledResult.voyage = voyage;
      if (receivedDate && !compiledResult.receivedDate) compiledResult.receivedDate = receivedDate;
    }

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item.status === "done" || item.status === "error") {
        continue;
      }

      setActiveQueueIdx(i);
      setQueue((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: "scanning" } : q))
      );

      try {
        let extractedData: PackingListScanResult;

        if (item.isExcel) {
          // Parse spreadsheet client-side directly
          extractedData = await parseExcelPackingList(item.file);
        } else {
          let previewData = item.preview;
          let finalMime = item.mimeType;

          if (!previewData) {
            const compressed = await compressImage(item.file, 1280, 0.75);
            previewData = compressed.dataUrl;
            finalMime = compressed.mimeType;
            setQueue((prev) =>
              prev.map((q) =>
                q.id === item.id ? { ...q, preview: compressed.dataUrl, mimeType: compressed.mimeType } : q
              )
            );
          }

          const base64Data = previewData.split(",")[1];
          const res = await fetch("/api/scan-packing-list", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              image: base64Data,
              mimeType: finalMime,
            }),
          });

          if (!res.ok) {
            throw new Error(await res.text());
          }

          extractedData = await res.json();
        }

        hadSuccess = true;

        // Apply pre-extracted metadata from filename as fallback if AI missed it or returned junk
        const { voyage: fileNameVoyage, receivedDate: fileNameDate } = extractMetadataFromFileName(item.name);
        
        // Voyage fallback: if empty or junk (like "NAME:")
        if (fileNameVoyage && (!extractedData.voyage || extractedData.voyage.toUpperCase().includes("NAME:"))) {
          extractedData.voyage = fileNameVoyage;
        }
        
        // Date fallback: if empty or looks like placeholder
        if (fileNameDate && (!extractedData.receivedDate || extractedData.receivedDate.includes("MM/DD/YYYY"))) {
          extractedData.receivedDate = fileNameDate;
        }

        // Tag items with source file ID
        const taggedItems = (extractedData.items || []).map(it => ({
          ...it,
          sourceFileId: item.id
        }));
        extractedData.items = taggedItems;

        // Compile metadata (favor non-empty extracted values for global fallback, avoiding junk)
        if (extractedData.supplier && extractedData.supplier.length > 2) {
          compiledResult.supplier = compiledResult.supplier || extractedData.supplier;
        }
        
        if (extractedData.voyage && extractedData.voyage.length > 1 && !extractedData.voyage.toUpperCase().includes("NAME:")) {
          compiledResult.voyage = compiledResult.voyage || extractedData.voyage;
        }

        if (extractedData.receivedDate && extractedData.receivedDate.length > 5 && !extractedData.receivedDate.includes("MM/DD/YYYY")) {
          compiledResult.receivedDate = compiledResult.receivedDate || extractedData.receivedDate;
        }

        compiledResult.propertyRemarks = compiledResult.propertyRemarks || extractedData.propertyRemarks || "";
        
        // Filter out duplicates when merging items globally
        const newItems = taggedItems.filter(newItem => 
          !compiledResult.items.some(existingItem => 
            existingItem.description.toLowerCase() === newItem.description.toLowerCase() &&
            existingItem.quantityReceived === newItem.quantityReceived &&
            existingItem.uom.toLowerCase() === newItem.uom.toLowerCase()
          )
        );
        
        compiledResult.items = [...compiledResult.items, ...newItems];

        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: "done", result: extractedData } : q))
        );
      } catch (err: any) {
        console.error("Batch list processing failure:", item.name, err);
        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: "error", error: err.message || "Failed to scan" } : q))
        );
      }
    }

    if (hadSuccess) {
      setScanResult(compiledResult);

      // Perform matching candidates matching against current SheetRows!
      const usedRowKeys = new Set<string>();
      const initialMatches: PackingListMatch[] = compiledResult.items.map((packItem) => {
        // Find best similarity candidate
        const candidates: MatchCandidate[] = freshRows
          .map((row) => {
            const isDelivered = row.status === "RECEIVED" || row.status === "SERVED" || row.corporateRemarks === "DELIVERED";
            
            let score = calculateSimilarity(packItem.description, row.itemDescription);
            
            // Do not auto-match items that are already delivered
            if (isDelivered) {
              score = 0;
            }

            // Department-based matching boost/penalty
            const packDept = normalizeDepartment(packItem.department || "");
            const rowDept = normalizeDepartment(row.chargingDepartment || "");
            
            // Enforce departmental matching
            if (packDept && rowDept && packDept !== rowDept) {
              score = 0;
            } else if (packDept && rowDept && packDept === rowDept && !isDelivered) {
              score += 0.3; // Boost score for matching departments
            }

            return {
              sheetRow: row,
              similarity: Math.min(score, 1.0), // Cap at 1.0
              exactRefMatch: false,
            };
          })
          .filter((c) => c.similarity > 0.15) // minimum threshold score
          .sort((a, b) => b.similarity - a.similarity);

        // Pick top first candidate if score is high enough AND not already assigned in this batch
        const bestCandidate = candidates.find(c => !usedRowKeys.has(`${c.sheetRow.tabName}-${c.sheetRow.rowIndex}`));
        const matchedRow = bestCandidate && bestCandidate.similarity > 0.6 ? bestCandidate.sheetRow : null;

        if (matchedRow) {
          usedRowKeys.add(`${matchedRow.tabName}-${matchedRow.rowIndex}`);
        }

        return {
          packingItem: packItem,
          matchedRow,
          autoMatchCandidates: candidates.slice(0, 5), // Keep top 5 matches
        };
      });

      setMatches(initialMatches);
    }

    setIsScanning(false);
    if (!hadSuccess && queue.some(q => q.status === "error")) {
      setError("Some or all documents failed to process. Check individual elements in the queue.");
    }
  };

  const updateMatchTarget = (matchIndex: number, targetRowIndex: number, tabName?: string) => {
    const nextMatches = [...matches];
    if (targetRowIndex === -1) {
      nextMatches[matchIndex].matchedRow = null;
    } else {
      const selected = sheetRows.find((r) => r.rowIndex === targetRowIndex && (!tabName || r.tabName === tabName));
      if (selected) {
        nextMatches[matchIndex].matchedRow = selected;
      }
    }
    setMatches(nextMatches);
  };

  const handleManualReceivedQty = (matchIndex: number, qty: number) => {
    const nextMatches = [...matches];
    nextMatches[matchIndex].packingItem.quantityReceived = qty;
    setMatches(nextMatches);
  };

  const resetAll = () => {
    setQueue([]);
    setActiveQueueIdx(-1);
    setScanResult(null);
    setMatches([]);
    setError(null);
  };

  const handleUpdateSheet = async () => {
    if (matches.length === 0 || !spreadsheetId) return;

    // Verify how many matches are valid
    const linkedMatches = matches.filter((m) => m.matchedRow !== null);
    if (linkedMatches.length === 0) {
      setError("No matched spreadsheet rows found. Please select matching requisition rows for at least one item.");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      // Aggregate updates by row key (tabName + rowIndex) to handle multiple packing items matching the same requisition row
      const aggregatedUpdates = new Map<string, { 
        rowIndex: number; 
        tabName?: string; 
        totalQty: number;
        scannedItems: any[];
        matchedRow: SheetRow;
      }>();

      for (const match of linkedMatches) {
        if (!match.matchedRow) continue;
        const key = `${match.matchedRow.tabName}-${match.matchedRow.rowIndex}`;
        
        const existing = aggregatedUpdates.get(key) || {
          rowIndex: match.matchedRow.rowIndex,
          tabName: match.matchedRow.tabName,
          totalQty: parseFloat(match.matchedRow.quantityReceived) || 0,
          scannedItems: [],
          matchedRow: match.matchedRow
        };

        existing.totalQty += match.packingItem.quantityReceived;
        existing.scannedItems.push(match);
        aggregatedUpdates.set(key, existing);
      }

      const updates: { rowIndex: number; updatedFields: Partial<SheetRow>; tabName?: string }[] = [];

      for (const [key, data] of aggregatedUpdates.entries()) {
        const match = data.scannedItems[0]; // Use first match for general metadata
        const sourceFile = queue.find(q => q.id === match.packingItem.sourceFileId);
        const fileMetadata = sourceFile?.result;
        
        const reqQty = parseFloat(data.matchedRow.quantityRequest) || 0;
        const newStatus: string = data.totalQty >= reqQty ? "RECEIVED" : "PARTIAL";

        updates.push({
          rowIndex: data.rowIndex,
          tabName: data.tabName,
          updatedFields: {
            status: newStatus,
            quantityReceived: String(data.totalQty),
            uomSecond: match.packingItem.uom,
            receivedDate: fileMetadata?.receivedDate || scanResult?.receivedDate || new Date().toLocaleDateString(),
            supplier: fileMetadata?.supplier || scanResult?.supplier || "",
            voyage: fileMetadata?.voyage || scanResult?.voyage || "",
            propertyRemarks: fileMetadata?.propertyRemarks || scanResult?.propertyRemarks || "",
            purchaseRequestRef: fileMetadata?.purchaseRequestRef || scanResult?.purchaseRequestRef || data.matchedRow.purchaseRequestRef,
            chargingDepartment: fileMetadata?.chargingDepartment || scanResult?.chargingDepartment || data.matchedRow.chargingDepartment,
            prDateReceived: fileMetadata?.prDateReceived || scanResult?.prDateReceived || data.matchedRow.prDateReceived,
            prDateSend: fileMetadata?.prDateSend || scanResult?.prDateSend || data.matchedRow.prDateSend,
            corporateRemarks: (newStatus === "RECEIVED" || newStatus === "SERVED") ? "DELIVERED" : data.matchedRow.corporateRemarks,
          }
        });
      }

      await batchUpdateSpreadsheetRows(accessToken, spreadsheetId, updates);
      resetAll();
      onSuccess();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to update verified items in Google Sheets.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleResultMetadataChange = (field: keyof PackingListScanResult, val: string, fileId?: string) => {
    if (fileId) {
      setQueue(prev => prev.map(q => {
        if (q.id === fileId && q.result) {
          return {
            ...q,
            result: {
              ...q.result,
              [field]: val
            }
          };
        }
        return q;
      }));
      return;
    }

    if (!scanResult) return;
    setScanResult({
      ...scanResult,
      [field]: val,
    });
  };

  const handleTransfer = async () => {
    if (!transferEmail || !accessToken || !spreadsheetId) return;
    
    setIsTransferring(true);
    try {
      const result = await copyFileToNewOwner(
        accessToken,
        spreadsheetId,
        transferEmail,
        transferTitle || undefined
      );

      alert(`${result.message}\n\nNew File ID: ${result.newFileId}\nStatus: ${result.status}`);
      setIsTransferModalOpen(false);
      setTransferEmail("");
      setTransferTitle("");
    } catch (err: any) {
      console.error("Transfer failed:", err);
      alert(`Transfer failed: ${err.message || "Unknown error"}`);
    } finally {
      setIsTransferring(false);
    }
  };

  const activeItem = activeQueueIdx !== -1 ? queue[activeQueueIdx] : null;

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Upload Block */}
      {queue.length === 0 ? (
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-slate-200 hover:border-blue-500 hover:bg-blue-50/10 cursor-pointer rounded-3xl p-16 text-center transition-all bg-white shadow-sm flex flex-col items-center justify-center space-y-6"
        >
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept="image/*,application/pdf,.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
            multiple
            onChange={handleFileChange}
          />
          <div className="p-5 bg-blue-50 text-blue-600 rounded-2xl shadow-inner">
            <Layers className="w-10 h-10" />
          </div>
          <div>
            <p className="text-slate-800 font-extrabold text-xl uppercase tracking-tight font-sans">
              Upload Packing Lists / Invoices
            </p>
            <p className="text-slate-450 text-xs mt-2 max-w-sm mx-auto leading-relaxed">
              Drag & Drop or click to choose Excel spreadsheets, PDFs, or captured paper invoices. Batch matching is enabled.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            <span className="text-[10px] font-bold text-slate-500 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200/60 flex items-center gap-1.5 font-mono">
              Auto multi-file matches
            </span>
            <span className="text-[10px] font-bold text-slate-500 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200/60 font-mono">
              Cross-references Google Sheet
            </span>
          </div>
        </div>
      ) : (
        <div className="max-w-6xl mx-auto animate-fadeIn">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left Sidebar: Queue & Matching Section */}
            <div className="lg:col-span-4 space-y-6">
              <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-sm space-y-6 sticky top-8">
                <div className="flex justify-between items-center pb-4 border-b border-slate-100">
                  <span className="text-xs font-bold text-slate-800 flex items-center gap-2 font-mono uppercase tracking-wider">
                    <Layers className="w-4 h-4 text-blue-600" /> QUEUE ({queue.length})
                  </span>
                  <button
                    onClick={resetAll}
                    className="text-[10px] text-rose-500 hover:text-rose-600 font-bold hover:underline cursor-pointer flex items-center gap-1 uppercase tracking-wider"
                  >
                    <X className="w-3.5 h-3.5" /> Clear
                  </button>
                </div>

                {/* Queue rows */}
                <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-200">
                  {queue.map((item, index) => {
                    const isActive = activeQueueIdx === index;
                    return (
                      <div
                        key={item.id}
                        onClick={() => setActiveQueueIdx(index)}
                        className={`p-3 rounded-2xl border flex items-center justify-between cursor-pointer transition-all ${
                          isActive
                            ? "border-blue-300 bg-blue-50/50 shadow-sm"
                            : "border-slate-100 hover:border-slate-200 bg-slate-50/30"
                        }`}
                      >
                        <div className="flex items-center gap-3 overflow-hidden">
                          <div className="w-9 h-9 bg-white rounded-xl border border-slate-200 flex items-center justify-center text-xs font-mono text-slate-400 flex-shrink-0 shadow-xs">
                            {item.preview && item.preview !== "excel_loaded_placeholder" ? (
                              <img src={item.preview} className="w-full h-full object-cover rounded-lg" alt="" />
                            ) : item.isExcel ? (
                              <span className="text-emerald-500 font-bold bg-emerald-50 w-full h-full flex items-center justify-center rounded-lg font-mono">XL</span>
                            ) : (
                              <FileCheck className="w-5 h-5" />
                            )}
                          </div>
                          <div className="truncate">
                            <span className="block font-bold text-slate-700 text-xs truncate font-sans">
                              {item.name}
                            </span>
                            <div className="mt-0.5 flex gap-2">
                              {item.status === "compressing" && (
                                <span className="text-[9px] text-amber-600 font-bold uppercase tracking-wider font-mono">Comp...</span>
                              )}
                              {item.status === "scanning" && (
                                <span className="text-[9px] text-blue-600 font-bold uppercase tracking-wider animate-pulse font-mono">Scan...</span>
                              )}
                              {item.status === "done" && (
                                <span className="text-[9px] text-emerald-600 font-bold uppercase tracking-wider font-mono">Ready</span>
                              )}
                              {item.status === "pending" && (
                                <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider font-mono">Wait</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <button
                          onClick={(e) => removeFromQueue(index, e)}
                          className="p-1.5 hover:bg-rose-50 rounded-lg text-slate-300 hover:text-rose-500 transition-colors flex-shrink-0 cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full py-3 border-2 border-dashed border-slate-100 rounded-2xl text-slate-400 hover:text-blue-500 hover:border-blue-200 transition-all text-xs font-bold flex items-center justify-center gap-2 cursor-pointer"
                  >
                    + Add more files
                  </button>
                </div>

                {/* Matching Range */}
                <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest">
                      Target Ledger
                    </label>
                    {isLoadingSheet && (
                      <span className="flex items-center gap-1 text-[9px] text-blue-600 font-bold animate-pulse font-mono">
                        <RefreshCw className="w-2.5 h-2.5 animate-spin" /> LOADING...
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    <button
                      onClick={() => setTargetSheet("ALL")}
                      className={`py-2.5 px-3 text-xs font-black rounded-xl border transition-all flex items-center justify-between cursor-pointer ${
                        targetSheet === "ALL"
                          ? "bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-100/50"
                          : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 shadow-xs"
                      }`}
                    >
                      <span>ALL TABS</span>
                      {targetSheet === "ALL" && <CheckCircle2 className="w-3.5 h-3.5" />}
                    </button>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setTargetSheet("PURCHASING")}
                        className={`flex-1 py-2.5 px-3 text-[10px] font-black rounded-xl border transition-all cursor-pointer ${
                          targetSheet === "PURCHASING"
                            ? "bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-100/50"
                            : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 shadow-xs"
                        }`}
                      >
                        PURCHASING
                      </button>
                      <button
                        onClick={() => setTargetSheet("OPERATIONS")}
                        className={`flex-1 py-2.5 px-3 text-[10px] font-black rounded-xl border transition-all cursor-pointer ${
                          targetSheet === "OPERATIONS"
                            ? "bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-100/50"
                            : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 shadow-xs"
                        }`}
                      >
                        OPERATIONS
                      </button>
                    </div>
                  </div>
                </div>

                {/* Verify Button */}
                <button
                  onClick={startBatchScan}
                  disabled={isScanning || queue.every((q) => q.status === "done" && q.result)}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-black text-sm rounded-2xl shadow-xl shadow-blue-100/30 transition-all flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed group"
                >
                  {isScanning ? (
                    <>
                      <RefreshCw className="w-5 h-5 animate-spin" />
                      MATCHING...
                    </>
                  ) : (
                    <>
                      <Play className="w-5 h-5 text-blue-200 fill-blue-200 group-hover:scale-110 transition-transform" />
                      {queue.some((q) => q.status === "done") ? "RESCAN QUEUE" : "START RECONCILE"}
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Right Side: Results & Status Section */}
            <div className="lg:col-span-8 space-y-6">
              {isScanning && (
                <div className="bg-white border border-slate-200 rounded-3xl p-12 shadow-sm flex flex-col justify-center items-center space-y-6 animate-pulse min-h-[400px]">
                  <RefreshCw className="w-16 h-16 text-blue-500 animate-spin" />
                  <div className="text-center">
                    <p className="text-slate-800 text-xl font-bold uppercase tracking-tight font-sans">
                      Analyzing Deliveries...
                    </p>
                    <p className="text-slate-450 text-xs mt-2 max-w-sm mx-auto leading-relaxed">
                      Parsing line items and cross-referencing with active requisitions in real-time.
                    </p>
                  </div>
                </div>
              )}

              {!isScanning && !scanResult && !error && (
                <div className="bg-white border border-slate-200 rounded-3xl p-12 shadow-sm text-center space-y-6 min-h-[400px] flex flex-col items-center justify-center">
                  <div className="w-20 h-20 bg-slate-50 text-slate-300 rounded-full flex items-center justify-center">
                    <HelpCircle className="w-10 h-10" />
                  </div>
                  <div className="max-w-md">
                    <p className="text-slate-800 text-base font-bold font-sans">Queue Ready</p>
                    <p className="text-slate-450 text-xs mt-2 leading-relaxed">
                      Click <strong className="text-slate-700 uppercase font-mono">Start Reconcile</strong> on the left to begin the matching process. We'll find corresponding ledger rows for each scanned item.
                    </p>
                  </div>
                </div>
              )}

              {error && (
                <div className="p-8 bg-rose-50 border border-rose-100 rounded-3xl text-rose-600 shadow-sm flex gap-4">
                  <AlertCircle className="w-8 h-8 flex-shrink-0" />
                  <div>
                    <p className="font-bold text-rose-800">System Warning</p>
                    <p className="text-sm text-rose-600 mt-1 leading-relaxed">{error}</p>
                  </div>
                </div>
              )}

              {scanResult && (() => {
                const displayMatches = matches.filter(m => {
                  if (targetSheet !== "OPERATIONS") return true;
                  const desc = m.packingItem.description.toUpperCase();
                  return !FOOD_KEYWORDS.some(kw => desc.includes(kw));
                });

                return (
                  <div className="space-y-6">
                    <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden animate-fadeIn">
                      <div className="px-8 py-5 bg-emerald-50/20 border-b border-emerald-100/40 flex justify-between items-center">
                        <div className="flex flex-col">
                          <span className="font-black text-slate-800 flex items-center gap-2 text-xs uppercase tracking-widest font-mono">
                            <CheckCircle2 className="w-5 h-5 text-emerald-500" /> Reconciliation Report
                          </span>
                          <span className="text-[10px] font-bold text-slate-400 mt-0.5">{displayMatches.length} Items Extracted</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => {
                              setIsTransferModalOpen(true);
                              setTransferTitle(`Copy for ${scanResult.supplier || "Supplier"} - ${new Date().toLocaleDateString()}`);
                            }}
                            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 shadow-lg shadow-blue-100 transition-all cursor-pointer text-[10px] font-black uppercase tracking-wider font-sans"
                          >
                            <Share2 className="w-3.5 h-3.5" />
                            <span>Export Copy</span>
                          </button>
                        </div>
                      </div>

                      <div className="p-6 space-y-10">
                        {/* Per-file metadata and items */}
                        <div className="space-y-12">
                          {queue.filter(q => q.status === "done" && q.result).map((fileItem) => {
                            const res = fileItem.result!;
                            const fileMatches = displayMatches.filter(m => m.packingItem.sourceFileId === fileItem.id);
                            
                            if (fileMatches.length === 0 && targetSheet === "OPERATIONS") return null;

                          return (
                            <div key={fileItem.id} className="space-y-6 animate-fadeIn pb-8 border-b border-slate-100 last:border-0 last:pb-0">
                            <div className="bg-slate-50/50 p-6 rounded-2xl border border-slate-100 shadow-sm">
                              <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-100/50">
                                <div className="flex items-center gap-3">
                                  <div className="p-2 bg-violet-100 text-violet-600 rounded-lg">
                                    <FileCheck className="w-5 h-5" />
                                  </div>
                                  <div>
                                    <h5 className="font-bold text-slate-700 text-sm">{fileItem.name}</h5>
                                    <p className="text-[10px] text-slate-400 font-medium uppercase tracking-widest">Document Metadata & Items</p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-100">
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  {fileMatches.length} ITEMS MATCHED
                                </div>
                              </div>
                              
                              <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
                                <div>
                                  <label className="block text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-2">
                                    Voyage #
                                  </label>
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[11px] text-slate-700 font-medium bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/20 transition-all"
                                    value={res.voyage || ""}
                                    onChange={(e) => handleResultMetadataChange("voyage", e.target.value, fileItem.id)}
                                    placeholder="Voyage #"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-2">
                                    Date Received
                                  </label>
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[11px] text-slate-700 font-medium bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/20 transition-all"
                                    value={res.receivedDate || ""}
                                    onChange={(e) => handleResultMetadataChange("receivedDate", e.target.value, fileItem.id)}
                                    placeholder="MM/DD/YYYY"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-2 truncate">
                                    Serial Ref (Matched)
                                  </label>
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[11px] text-slate-700 font-bold bg-amber-50/30 focus:outline-none focus:ring-2 focus:ring-violet-500/20 transition-all"
                                    value={res.purchaseRequestRef || ""}
                                    onChange={(e) => handleResultMetadataChange("purchaseRequestRef", e.target.value, fileItem.id)}
                                    placeholder="UNLINKED"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-2">
                                    Charging Dept
                                  </label>
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[11px] text-slate-700 font-medium bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/20 transition-all"
                                    value={res.chargingDepartment || ""}
                                    onChange={(e) => handleResultMetadataChange("chargingDepartment", e.target.value, fileItem.id)}
                                    placeholder="N/A"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-2">
                                    PR Date Recv
                                  </label>
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[11px] text-slate-700 font-medium bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/20 transition-all"
                                    value={res.prDateReceived || ""}
                                    onChange={(e) => handleResultMetadataChange("prDateReceived", e.target.value, fileItem.id)}
                                    placeholder="N/A"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-2">
                                    PR Date Send
                                  </label>
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[11px] text-slate-700 font-medium bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/20 transition-all"
                                    value={res.prDateSend || ""}
                                    onChange={(e) => handleResultMetadataChange("prDateSend", e.target.value, fileItem.id)}
                                    placeholder="N/A"
                                  />
                                </div>
                              </div>
                            </div>

                            {/* Items for this specific file */}
                            <div className="space-y-4">
                              {fileMatches.map((match, mIdx) => {
                                const realIdx = matches.findIndex(m => m === match);
                                return (
                                  <div
                                    key={`${fileItem.id}-${mIdx}`}
                                    className={`p-5 rounded-2xl border transition-all ${
                                      match.matchedRow
                                        ? "bg-white border-slate-100 shadow-sm hover:border-violet-200"
                                        : "bg-red-50/30 border-red-100"
                                    }`}
                                  >
                                    <div className="flex flex-col md:flex-row md:items-center gap-6">
                                      <div className="md:w-1/4">
                                        <div className="flex items-center gap-2 mb-1">
                                          <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                                            Delivered Item (Extracted)
                                          </label>
                                        </div>
                                        <p className="text-[11px] font-bold text-slate-800 leading-tight">
                                          {match.packingItem.description}
                                        </p>
                                        <p className="text-[10px] text-slate-400 mt-1">
                                          UOM: <span className="font-medium text-slate-500">{match.packingItem.uom}</span>
                                        </p>
                                        {match.matchedRow && (
                                          <div className="mt-2 flex flex-wrap gap-2">
                                            <div className="flex items-center gap-1 px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[9px] font-bold uppercase tracking-wider border border-slate-200">
                                              <Hash className="w-2.5 h-2.5" /> PR: {match.matchedRow.purchaseRequestRef || "N/A"}
                                            </div>
                                            {(() => {
                                              const candidate = match.autoMatchCandidates.find(c => 
                                                c.sheetRow.rowIndex === match.matchedRow?.rowIndex && 
                                                c.sheetRow.tabName === match.matchedRow?.tabName
                                              );
                                              if (candidate) {
                                                const score = Math.round(candidate.similarity * 100);
                                                return (
                                                  <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${
                                                    score > 80 ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 
                                                    score > 50 ? 'bg-amber-50 text-amber-600 border-amber-100' : 
                                                    'bg-slate-50 text-slate-400 border-slate-100'
                                                  }`}>
                                                    <Percent className="w-2.5 h-2.5" /> Match: {score}%
                                                  </div>
                                                );
                                              }
                                              return (
                                                <div className="flex items-center gap-1 px-1.5 py-0.5 bg-sky-50 text-sky-600 rounded text-[9px] font-bold uppercase tracking-wider border border-sky-100">
                                                  <User className="w-2.5 h-2.5" /> Manual Match
                                                </div>
                                              );
                                            })()}
                                            {(match.matchedRow.status === "RECEIVED" || match.matchedRow.status === "SERVED" || match.matchedRow.corporateRemarks === "DELIVERED") && (
                                              <div className="flex items-center gap-1 px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded text-[9px] font-black uppercase tracking-wider border border-emerald-200">
                                                Already Delivered
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>

                                      <div className="md:flex-1">
                                        <div className="flex items-center justify-between mb-2">
                                          <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                                            Linked Requisition Row
                                          </label>
                                          {match.matchedRow && (match.matchedRow.status === "RECEIVED" || match.matchedRow.status === "SERVED" || match.matchedRow.corporateRemarks === "DELIVERED") && (
                                            <span className="text-[9px] font-black text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200 flex items-center gap-1 animate-fadeIn">
                                              <CheckCircle2 className="w-2.5 h-2.5" /> ALREADY DELIVERED
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                          <select
                                            className={`w-full px-3 py-2 border rounded-xl text-[11px] font-medium transition-all focus:outline-none focus:ring-2 ${
                                              match.matchedRow
                                                ? "bg-white border-slate-200 text-slate-700 focus:ring-violet-500/20"
                                                : "bg-red-50 border-red-200 text-red-600 focus:ring-red-500/20"
                                            }`}
                                            value={match.matchedRow ? `${match.matchedRow.tabName}///${match.matchedRow.rowIndex}` : "-1"}
                                            onChange={(e) => {
                                              const val = e.target.value;
                                              if (val === "-1") {
                                                updateMatchTarget(realIdx, -1);
                                              } else {
                                                const [tab, indexStr] = val.split("///");
                                                updateMatchTarget(realIdx, parseInt(indexStr), tab);
                                              }
                                            }}
                                          >
                                            <option value="-1">-- Unlinked --</option>
                                            {/* Reflection Fix: Ensure manually matched row is visible in the list */}
                                            {match.matchedRow && !match.autoMatchCandidates.some(c => c.sheetRow.rowIndex === match.matchedRow?.rowIndex && c.sheetRow.tabName === match.matchedRow?.tabName) && (
                                              <option value={`${match.matchedRow.tabName}///${match.matchedRow.rowIndex}`}>
                                                [MANUAL] [{match.matchedRow.tabName}] {match.matchedRow.itemDescription.substring(0, 50)}
                                              </option>
                                            )}
                                            {match.autoMatchCandidates.map((cand) => (
                                              <option 
                                                key={`${cand.sheetRow.tabName}///${cand.sheetRow.rowIndex}`} 
                                                value={`${cand.sheetRow.tabName}///${cand.sheetRow.rowIndex}`}
                                              >
                                                [{cand.sheetRow.tabName}] {cand.sheetRow.itemDescription.substring(0, 50)}
                                              </option>
                                            ))}
                                          </select>
                                          <button
                                            onClick={() => {
                                              setSearchModalIndex(realIdx);
                                              setRowSearchQuery(match.packingItem.description);
                                            }}
                                            className="p-2 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition-colors"
                                            title="Manual Search"
                                          >
                                            <Edit3 className="w-4 h-4" />
                                          </button>
                                        </div>
                                      </div>

                                      <div className="flex items-center gap-6 md:w-auto">
                                        <div className="text-center">
                                          <label className="block text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-2">
                                            Qty Recv
                                          </label>
                                          <input
                                            type="number"
                                            className="w-20 px-2 py-2 border border-slate-200 rounded-xl text-center text-xs font-bold text-slate-700 bg-white focus:ring-2 focus:ring-violet-500/20"
                                            value={match.packingItem.quantityReceived}
                                            onChange={(e) => handleManualReceivedQty(realIdx, parseFloat(e.target.value) || 0)}
                                          />
                                        </div>

                                        <div className="flex flex-col items-center">
                                          <label className="block text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-2">
                                            Match
                                          </label>
                                          <div
                                            className={`w-3 h-3 rounded-full ${
                                              match.matchedRow ? "bg-emerald-500 shadow-sm shadow-emerald-200" : "bg-red-400 animate-pulse"
                                            }`}
                                          />
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>


                  <div className="px-8 py-6 bg-slate-50 border-t border-slate-100 flex justify-end gap-4">
                    <button
                      onClick={resetAll}
                      className="px-6 py-3 text-sm font-bold text-slate-400 hover:text-slate-600 transition-colors"
                    >
                      Clear & Reset
                    </button>
                    <button
                      onClick={handleUpdateSheet}
                      disabled={isSaving || displayMatches.every((m) => !m.matchedRow)}
                      className="px-8 py-3 bg-violet-600 hover:bg-violet-700 text-white font-black text-sm rounded-xl shadow-lg shadow-violet-200 transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50"
                    >
                      {isSaving ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          UPDATING...
                        </>
                      ) : (
                        <>
                          <Save className="w-4 h-4" />
                          COMPLETE RECONCILIATION ({displayMatches.filter(m => m.matchedRow).length})
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}
            </div>
          </div>
        </div>
      )}

      {/* Manual Search Modal */}
      {searchModalIndex !== null && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden animate-scaleIn">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                <Search className="w-4 h-4 text-violet-500" /> Search Requisition Items
              </h3>
              <button 
                onClick={() => setSearchModalIndex(null)}
                className="p-1 hover:bg-slate-200 rounded-lg text-slate-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  autoFocus
                  className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all"
                  placeholder="Search by description, serial, or department..."
                  value={rowSearchQuery}
                  onChange={(e) => setRowSearchQuery(e.target.value)}
                />
              </div>

              <div className="max-h-[400px] overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                {sheetRows
                  .filter(r => 
                    r.itemDescription.toLowerCase().includes(rowSearchQuery.toLowerCase()) ||
                    r.purchaseRequestRef.toLowerCase().includes(rowSearchQuery.toLowerCase()) ||
                    r.chargingDepartment.toLowerCase().includes(rowSearchQuery.toLowerCase())
                  )
                  .map((row) => (
                    <button
                      key={`${row.tabName}///${row.rowIndex}`}
                      onClick={() => {
                        updateMatchTarget(searchModalIndex, row.rowIndex, row.tabName);
                        setSearchModalIndex(null);
                      }}
                      className="w-full text-left p-3 hover:bg-violet-50 rounded-xl transition-colors border border-transparent hover:border-violet-100 group"
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-slate-800 group-hover:text-violet-700 line-clamp-1">
                            {row.itemDescription}
                          </p>
                          <div className="flex flex-wrap gap-2 mt-1">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tight bg-slate-100 px-1.5 py-0.5 rounded">
                              {row.tabName} Row {row.rowIndex}
                            </span>
                            <span className="text-[10px] font-bold text-violet-500 bg-violet-50 px-1.5 py-0.5 rounded">
                              {row.purchaseRequestRef}
                            </span>
                            <span className="text-[10px] font-bold text-teal-600 bg-teal-50 px-1.5 py-0.5 rounded">
                              {row.chargingDepartment}
                            </span>
                          </div>
                        </div>
                        <div className="text-right flex flex-col items-end gap-1 flex-shrink-0">
                          <span className="text-xs font-bold text-slate-700">
                            Req: {row.quantityRequest} {row.uomFirst || "pcs"}
                          </span>
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                            row.status.toUpperCase() === "PENDING" 
                              ? "bg-amber-100 text-amber-700" 
                              : row.status.toUpperCase() === "PARTIAL"
                              ? "bg-sky-100 text-sky-700"
                              : "bg-emerald-100 text-emerald-700"
                          }`}>
                            {row.status}
                          </span>
                        </div>
                      </div>
                    </button>
                  ))}
                
                {sheetRows.filter(r => 
                  r.itemDescription.toLowerCase().includes(rowSearchQuery.toLowerCase()) ||
                  r.purchaseRequestRef.toLowerCase().includes(rowSearchQuery.toLowerCase()) ||
                  r.chargingDepartment.toLowerCase().includes(rowSearchQuery.toLowerCase())
                ).length === 0 && (
                  <div className="py-12 text-center space-y-2">
                    <HelpCircle className="w-10 h-10 mx-auto text-slate-200" />
                    <p className="text-slate-400 text-sm">No matching requisition items found</p>
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setSearchModalIndex(null)}
                className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-800 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transfer Ownership Modal */}
      {isTransferModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden transform scale-100 transition-all">
            <div className="px-6 py-4 bg-indigo-50 border-b border-indigo-150 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-indigo-100 text-indigo-600 rounded-lg">
                  <Share2 className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-slate-800 text-sm">Transfer Ownership</h4>
                  <p className="text-[10px] text-slate-400">Clone & move spreadsheet to a new owner</p>
                </div>
              </div>
              <button
                onClick={() => setIsTransferModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="p-3 bg-amber-50 rounded-xl border border-amber-100 text-[11px] text-amber-700 leading-relaxed">
                <p><strong>Note:</strong> This will create a fresh copy of your current linked spreadsheet and attempt to transfer ownership to the email provided.</p>
              </div>

              <div className="space-y-3.5">
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Recipient Email</label>
                  <input
                    type="email"
                    placeholder="user@example.com"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    value={transferEmail}
                    onChange={(e) => setTransferEmail(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Copy Name</label>
                  <input
                    type="text"
                    placeholder="New Spreadsheet Name"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    value={transferTitle}
                    onChange={(e) => setTransferTitle(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end gap-2.5">
              <button
                onClick={() => setIsTransferModalOpen(false)}
                className="px-4 py-1.5 border border-slate-200 text-slate-600 hover:bg-slate-100 rounded-lg text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleTransfer}
                disabled={isTransferring || !transferEmail}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg text-xs cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
              >
                {isTransferring ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" /> Start Transfer
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
