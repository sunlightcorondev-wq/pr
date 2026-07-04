import { SheetRow } from "./types";

export const HEADERS = [
  "PURCHASE REQUEST REF:",
  "CATEGORY",
  "ITEM DESCRIPTION",
  "QUANTITY REQUEST",
  "UOM",
  "PR Date Received",
  "PR Date Send",
  "Charging Department",
  "STATUS",
  "CORPORATE REMARKS",
  "RECEIVED DATE",
  "AMOUNT",
  "SUPPLIER",
  "PAYMENT METHODS",
  "QUANTITY RECEIVED",
  "UOM",
  "PROPERTY REMARKS",
  "VOYAGE"
];

// Helper to extract spreadsheet ID from share URL or return as-is
export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : trimmed;
}

// Get all sheet titles in the workbook
export async function getAllSheetTitles(accessToken: string, spreadsheetId: string): Promise<string[]> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  try {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}?fields=sheets(properties(title))`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.sheets) {
        return data.sheets.map((s: any) => s.properties.title);
      }
    }
  } catch (err) {
    console.warn("Could not fetch sheet titles:", err);
  }
  return ["PURCHASING", "OPERATIONS"]; // Fallback
}
// Dynamically determine the actual title of the first sheet tab (index 0) in the workbook
export async function getFirstSheetTitle(accessToken: string, spreadsheetId: string): Promise<string> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  try {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}?fields=sheets(properties(title,sheetId))`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.sheets && data.sheets.length > 0) {
        return data.sheets[0].properties.title;
      }
    }
  } catch (err) {
    console.warn("Could not fetch sheet titles, defaulting to Sheet1:", err);
  }
  return "Sheet1";
}

// Get the actual sheetId (GID) of the first tab in the workbook
export async function getFirstSheetGid(accessToken: string, spreadsheetId: string): Promise<number> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  try {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}?fields=sheets(properties(sheetId))`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.sheets && data.sheets.length > 0) {
        const gid = data.sheets[0].properties.sheetId;
        return typeof gid === "number" ? gid : 0;
      }
    }
  } catch (err) {
    console.warn("Could not fetch sheet sheetId, defaulting to 0:", err);
  }
  return 0;
}

// Get GID of a sheet by its title
export async function getSheetGidByTitle(accessToken: string, spreadsheetId: string, title: string): Promise<number> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  try {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}?fields=sheets(properties(title,sheetId))`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.sheets && data.sheets.length > 0) {
        const found = data.sheets.find((s: any) => s.properties.title.toLowerCase().trim() === title.toLowerCase().trim());
        if (found) {
          return found.properties.sheetId;
        }
      }
    }
  } catch (err) {
    console.warn("Could not fetch sheet GID by title:", err);
  }
  return 0;
}

// Ensure sheet tab exists in workbook, create it with headers if missing
export async function ensureSheetExists(accessToken: string, spreadsheetId: string, title: string): Promise<void> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  try {
    const resCheck = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}?fields=sheets(properties(title))`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resCheck.ok) {
      const data = await resCheck.json();
      const titles: string[] = (data.sheets || []).map((s: any) => s.properties.title);
      if (titles.some(t => t.toLowerCase().trim() === title.toLowerCase().trim())) {
        return; // Already exists!
      }
    }

    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title: title,
              },
            },
          },
        ],
      }),
    });

    if (res.ok) {
      const range = `'${title}'!A1`;
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          range: range,
          majorDimension: "ROWS",
          values: [HEADERS],
        }),
      });
    }
  } catch (err) {
    console.error(`Failed to ensure/create sheet tab "${title}"`, err);
  }
}

// Create a new Spreadsheet with headers
export async function createSpreadsheet(accessToken: string, title: string): Promise<{ id: string; url: string }> {
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        title: title || "SGHC PR Monitoring 2026",
      },
      sheets: [
        {
          properties: {
            title: "PURCHASING",
          },
        },
        {
          properties: {
            title: "OPERATIONS",
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Failed to create spreadsheet: ${res.statusText}`);
  }

  const data = await res.json();
  const spreadsheetId = data.spreadsheetId;
  const spreadsheetUrl = data.spreadsheetUrl;

  const firstSheetTitle = await getFirstSheetTitle(accessToken, spreadsheetId);

  // Append Headers
  const range = `'${firstSheetTitle}'!A1`;
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      range: range,
      majorDimension: "ROWS",
      values: [HEADERS],
    }),
  });

  // Write timestamp to Dashboard D1/D2
  await ensureDashboardAndWriteTimestamp(accessToken, spreadsheetId).catch(console.error);

  return { id: spreadsheetId, url: spreadsheetUrl };
}

// Fetch all rows and map to SheetRow instances
export async function fetchSpreadsheetRows(accessToken: string, spreadsheetId: string, sheetTitle?: string): Promise<SheetRow[]> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  const activeTitle = sheetTitle || await getFirstSheetTitle(accessToken, cleanId);
  
  const range = `'${activeTitle}'!A:R`;
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values/${encodeURIComponent(range)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Failed to fetch sheet rows: ${res.statusText}`);
  }

  const data = await res.json();
  const values: string[][] = data.values || [];

  if (values.length === 0) {
    return [];
  }

  // Dynamically find where the header row is in the spreadsheet
  let headerRowIndex = 0; // Default to row 1 (0-indexed)
  for (let i = 0; i < values.length; i++) {
    const rowElements = (values[i] || []).map(v => String(v).toUpperCase().trim());
    if (
      rowElements.includes("PURCHASE REQUEST REF:") || 
      rowElements.includes("PURCHASE REQUEST REF") || 
      rowElements.includes("ITEM DESCRIPTION")
    ) {
      headerRowIndex = i;
      break;
    }
  }

  const rows: SheetRow[] = [];
  // Parse rows, starting from the row after the headers
  for (let i = headerRowIndex + 1; i < values.length; i++) {
    const col = values[i];
    if (!col || col.length === 0) continue;

    // Helper to extract index safely
    const getVal = (idx: number) => (col[idx] !== undefined ? String(col[idx]).trim() : "");

    // If both the purchase request reference and item description are empty, skip to bypass empty template placeholders
    if (!getVal(0) && !getVal(2)) {
      continue;
    }

    rows.push({
      rowIndex: i + 1, // Row number in spreadsheet (1-indexed)
      tabName: activeTitle, // Store the spreadsheet tab/sheet name
      purchaseRequestRef: getVal(0),
      category: getVal(1),
      itemDescription: getVal(2),
      quantityRequest: getVal(3),
      uomFirst: getVal(4),
      prDateReceived: getVal(5),
      prDateSend: getVal(6),
      chargingDepartment: getVal(7),
      status: getVal(8) || "PENDING",
      corporateRemarks: getVal(9),
      receivedDate: getVal(10),
      amount: getVal(11),
      supplier: getVal(12),
      paymentMethods: getVal(13),
      quantityReceived: getVal(14),
      uomSecond: getVal(15),
      propertyRemarks: getVal(16),
      voyage: getVal(17),
    });
  }

  return rows;
}

// Append new requisition rows to Google Sheets
export async function appendRequisitionRows(
  accessToken: string,
  spreadsheetId: string,
  newRows: {
    purchaseRequestRef: string;
    category: string;
    itemDescription: string;
    quantityRequest: string;
    uomFirst: string;
    prDateReceived: string;
    prDateSend: string;
    chargingDepartment: string;
    status: string;
  }[],
  sheetTitle?: string
): Promise<void> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  const activeTitle = sheetTitle || await getFirstSheetTitle(accessToken, cleanId);

  // Proactively create sheet tab with headers if missing
  await ensureSheetExists(accessToken, cleanId, activeTitle);

  // Fetch the current contents to locate the header and the first empty slot
  const fetchRange = `'${activeTitle}'!A:R`;
  const fetchRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values/${encodeURIComponent(fetchRange)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  let values: string[][] = [];
  if (fetchRes.ok) {
    const data = await fetchRes.json();
    values = data.values || [];
  }

  // Find where the headers are
  let headerRowIndex = 0; // Default to row 1 (0-indexed 0)
  for (let i = 0; i < values.length; i++) {
    const rowElements = (values[i] || []).map(v => String(v).toUpperCase().trim());
    if (
      rowElements.includes("PURCHASE REQUEST REF:") || 
      rowElements.includes("PURCHASE REQUEST REF") || 
      rowElements.includes("ITEM DESCRIPTION")
    ) {
      headerRowIndex = i;
      break;
    }
  }

  // To insert at the top, we first insert empty rows below the header
  const sheetGid = await getSheetGidByTitle(accessToken, cleanId, activeTitle);
  
  // Insert N rows below the header
  const insertRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: sheetGid,
              dimension: "ROWS",
              startIndex: headerRowIndex + 1,
              endIndex: headerRowIndex + 1 + newRows.length,
            },
            inheritFromBefore: true,
          },
        },
      ],
    }),
  });

  if (!insertRes.ok) {
    const errData = await insertRes.json().catch(() => ({}));
    console.error("Failed to insert rows for top-of-table placement:", errData);
    // Fallback to appending if insertion fails? 
    // Actually, let's just proceed with the original logic if insertion fails, 
    // but the targetRowIndex logic below needs to be aware.
  }

  // Now write the data to the newly inserted rows
  const targetRowIndex = headerRowIndex + 2; 
  
  // Transform to string grid
  const valueGrid = newRows.map((r) => [
    r.purchaseRequestRef,
    r.category,
    r.itemDescription,
    r.quantityRequest,
    r.uomFirst,
    r.prDateReceived,
    r.prDateSend,
    r.chargingDepartment,
    r.status,
    "", // Corporate remarks
    "", // Received date
    "", // Amount
    "", // Supplier
    "", // Payment methods
    "", // Qty received
    "", // Received UOM
    "", // Property remarks
    ""  // Voyage
  ]);

  const range = `'${activeTitle}'!A${targetRowIndex}`;
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      range: range,
      majorDimension: "ROWS",
      values: valueGrid,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || "Failed to add items to Google Sheets");
  }

  // Write timestamp to Dashboard D1/D2
  await ensureDashboardAndWriteTimestamp(accessToken, cleanId, activeTitle).catch(console.error);
}

// Update multiple rows in Google Sheets using a single batch request to save on quota
/**
 * Specialized batch update for Corporate Remarks column (Index 9 / Column J)
 * Uses spreadsheets.batchUpdate with UpdateCellsRequest for efficiency and reliability.
 */
export async function batchUpdateCorporateRemarks(
  accessToken: string,
  spreadsheetId: string,
  updates: { rowIndex: number; tabName: string; value: string }[]
) {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  
  // 1. Get GIDs for all tabs involved
  const tabNames = Array.from(new Set(updates.map(u => u.tabName)));
  const gids: Record<string, number> = {};
  
  try {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}?fields=sheets(properties(title,sheetId))`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      data.sheets?.forEach((s: any) => {
        gids[s.properties.title] = s.properties.sheetId;
      });
    }
  } catch (err) {
    console.error("Failed to fetch sheet GIDs:", err);
  }

  // 2. Build the requests
  const requests = updates.map(u => {
    const sheetId = gids[u.tabName] !== undefined ? gids[u.tabName] : 0;
    return {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: u.rowIndex - 1, // 0-indexed
          endRowIndex: u.rowIndex,
          startColumnIndex: 9, // Column J is index 9
          endColumnIndex: 10
        },
        rows: [
          {
            values: [
              {
                userEnteredValue: {
                  stringValue: u.value
                }
              }
            ]
          }
        ],
        fields: "userEnteredValue"
      }
    };
  });

  // 3. Send in chunks
  const CHUNK_SIZE = 100;
  for (let i = 0; i < requests.length; i += CHUNK_SIZE) {
    const chunk = requests.slice(i, i + CHUNK_SIZE);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests: chunk }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Batch update failed: ${err.error?.message || res.statusText}`);
    }
  }
}

/**
 * Creates a copy of the spreadsheet and shares it with a new email address.
 * Note: Transferring ownership via API usually requires the new owner to be in the same Workspace domain.
 * If cross-domain, it will add them as an Editor with permission to transfer manually.
 */
export async function copyFileToNewOwner(
  accessToken: string,
  fileId: string,
  newOwnerEmail: string,
  newTitle?: string
) {
  const cleanId = extractSpreadsheetId(fileId);
  
  // 1. Copy the file
  const copyRes = await fetch(`https://www.googleapis.com/drive/v3/files/${cleanId}/copy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: newTitle || `Copy of Sunlight Purchasing - ${new Date().toLocaleDateString()}`,
    }),
  });

  if (!copyRes.ok) {
    const err = await copyRes.json().catch(() => ({}));
    throw new Error(`Failed to copy file: ${err.error?.message || copyRes.statusText}`);
  }

  const newFile = await copyRes.json();
  const newFileId = newFile.id;

  // 2. Add the new owner/editor permission
  // We try to transfer ownership if possible, otherwise fallback to Editor
  const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${newFileId}/permissions?transferOwnership=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      role: "owner",
      type: "user",
      emailAddress: newOwnerEmail,
    }),
  });

  if (!permRes.ok) {
    // If "owner" transfer fails (common for cross-domain), fallback to "editor"
    const fallbackRes = await fetch(`https://www.googleapis.com/drive/v3/files/${newFileId}/permissions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "editor",
        type: "user",
        emailAddress: newOwnerEmail,
      }),
    });

    if (!fallbackRes.ok) {
      const err = await fallbackRes.json().catch(() => ({}));
      throw new Error(`Copied successfully (ID: ${newFileId}), but failed to share: ${err.error?.message || fallbackRes.statusText}`);
    }
    
    return {
      success: true,
      newFileId,
      status: "SHARED_AS_EDITOR",
      message: "File copied, but ownership transfer blocked by domain policy. Added as Editor instead."
    };
  }

  return {
    success: true,
    newFileId,
    status: "OWNERSHIP_TRANSFERRED",
    message: "File copied and ownership successfully transferred."
  };
}

export async function batchUpdateSpreadsheetRows(
  accessToken: string,
  spreadsheetId: string,
  updates: {
    rowIndex: number;
    updatedFields: Partial<SheetRow>;
    tabName?: string;
  }[]
): Promise<void> {
  if (updates.length === 0) return;

  const cleanId = extractSpreadsheetId(spreadsheetId);
  
  // To avoid overwriting manually edited cells that we don't know about, 
  // we SHOULD fetch the rows first, but fetching many individual rows is slow.
  // Instead, let's group by tab and fetch the min/max range needed.
  
  const updatesByTab: { [tab: string]: typeof updates } = {};
  updates.forEach(u => {
    const tab = u.tabName || "Sheet1"; // fallback if unknown, though we should know it
    if (!updatesByTab[tab]) updatesByTab[tab] = [];
    updatesByTab[tab].push(u);
  });

  const batchData: any[] = [];

  for (const tabName in updatesByTab) {
    const tabUpdates = updatesByTab[tabName];
    
    // Chunk updates to avoid hitting URL length limits on batchGet
    const CHUNK_SIZE = 25;
    for (let k = 0; k < tabUpdates.length; k += CHUNK_SIZE) {
      const chunk = tabUpdates.slice(k, k + CHUNK_SIZE);
      
      const rangesToFetch = chunk.map(u => `'${tabName}'!A${u.rowIndex}:R${u.rowIndex}`);
      const fetchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values:batchGet?${rangesToFetch.map(r => `ranges=${encodeURIComponent(r)}`).join("&")}`;
      
      const fetchRes = await fetch(fetchUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!fetchRes.ok) {
        const err = await fetchRes.json().catch(() => ({}));
        throw new Error(`Batch fetch failed: ${err.error?.message || fetchRes.statusText}`);
      }

      const fetchedData = await fetchRes.json();
      const valueRanges = fetchedData.valueRanges || [];

      chunk.forEach((u, i) => {
        let existingCells = Array(18).fill("");
        if (valueRanges[i] && valueRanges[i].values && valueRanges[i].values[0]) {
          existingCells = valueRanges[i].values[0];
          while (existingCells.length < 18) existingCells.push("");
        }

        // Map fields
        const updateMap: { [key: number]: string | undefined } = {
          0: u.updatedFields.purchaseRequestRef,
          1: u.updatedFields.category,
          2: u.updatedFields.itemDescription,
          3: u.updatedFields.quantityRequest,
          4: u.updatedFields.uomFirst,
          5: u.updatedFields.prDateReceived,
          6: u.updatedFields.prDateSend,
          7: u.updatedFields.chargingDepartment,
          8: u.updatedFields.status,
          9: u.updatedFields.corporateRemarks,
          10: u.updatedFields.receivedDate,
          11: u.updatedFields.amount,
          12: u.updatedFields.supplier,
          13: u.updatedFields.paymentMethods,
          14: u.updatedFields.quantityReceived,
          15: u.updatedFields.uomSecond,
          16: u.updatedFields.propertyRemarks,
          17: u.updatedFields.voyage,
        };

        for (let idx = 0; idx < 18; idx++) {
          if (updateMap[idx] !== undefined) {
            existingCells[idx] = updateMap[idx];
          }
        }

        batchData.push({
          range: `'${tabName}'!A${u.rowIndex}:R${u.rowIndex}`,
          majorDimension: "ROWS",
          values: [existingCells],
        });
      });
    }
  }

  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: batchData,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || "Failed to batch update Google Sheets");
  }

  // Write timestamp ONCE at the end
  await ensureDashboardAndWriteTimestamp(accessToken, cleanId).catch(console.error);
}

// Update single row in Google Sheets
export async function updateSpreadsheetRow(
  accessToken: string,
  spreadsheetId: string,
  rowIndex: number,
  updatedFields: Partial<SheetRow>,
  sheetTitle?: string
): Promise<void> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  const activeTitle = sheetTitle || await getFirstSheetTitle(accessToken, cleanId);

  // 1. First fetch exact existing row values to avoid washing out other manually edited cells
  const range = `'${activeTitle}'!A${rowIndex}:R${rowIndex}`;
  const fetchRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values/${encodeURIComponent(range)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  let existingCells = Array(18).fill("");
  if (fetchRes.ok) {
    const data = await fetchRes.json();
    if (data.values && data.values[0]) {
      existingCells = data.values[0];
      // Ensure it has exactly 18 cells padding
      while (existingCells.length < 18) {
        existingCells.push("");
      }
    }
  }

  // 2. Map updated fields over existing cells
  const updateMap: { [key: number]: string | undefined } = {
    0: updatedFields.purchaseRequestRef,
    1: updatedFields.category,
    2: updatedFields.itemDescription,
    3: updatedFields.quantityRequest,
    4: updatedFields.uomFirst,
    5: updatedFields.prDateReceived,
    6: updatedFields.prDateSend,
    7: updatedFields.chargingDepartment,
    8: updatedFields.status,
    9: updatedFields.corporateRemarks,
    10: updatedFields.receivedDate,
    11: updatedFields.amount,
    12: updatedFields.supplier,
    13: updatedFields.paymentMethods,
    14: updatedFields.quantityReceived,
    15: updatedFields.uomSecond,
    16: updatedFields.propertyRemarks,
    17: updatedFields.voyage,
  };

  for (let idx = 0; idx < 18; idx++) {
    if (updateMap[idx] !== undefined) {
      existingCells[idx] = updateMap[idx];
    }
  }

  // 3. Write back
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      range: range,
      majorDimension: "ROWS",
      values: [existingCells],
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || "Failed to update cell values in Google Sheets");
  }

  // Write timestamp to Dashboard D1/D2
  await ensureDashboardAndWriteTimestamp(accessToken, cleanId, activeTitle).catch(console.error);
}

// Delete a row in Google Sheets (clears it or deletes the dimension)
export async function deleteSpreadsheetRow(
  accessToken: string,
  spreadsheetId: string,
  rowIndex: number,
  sheetTitle?: string
): Promise<void> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  const activeTitle = sheetTitle || await getFirstSheetTitle(accessToken, cleanId);
  const sheetGid = sheetTitle ? await getSheetGidByTitle(accessToken, cleanId, sheetTitle) : await getFirstSheetGid(accessToken, cleanId);

  // Sheets API doesn't have a simple row DELETE URL, rather it is a batchUpdate request to deleteDimension
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheetGid, // dynamically retrieved sheetId
              dimension: "ROWS",
              startIndex: rowIndex - 1, // 0-indexed start (inclusive)
              endIndex: rowIndex,       // 0-indexed end (exclusive)
            },
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    // If sheetId triggers errors, fallback to clearing range values
    const range = `'${activeTitle}'!A${rowIndex}:R${rowIndex}`;
    const clearRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values/${encodeURIComponent(range)}:clear`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!clearRes.ok) {
      throw new Error("Failed to clear / delete spreadsheet row");
    }
  }

  // Write timestamp to Dashboard D1/D2
  await ensureDashboardAndWriteTimestamp(accessToken, cleanId, activeTitle).catch(console.error);
}

// Helper to write update timestamp on cells D1 and D2 of the primary sheet
export async function ensureDashboardAndWriteTimestamp(accessToken: string, spreadsheetId: string, sheetTitle?: string): Promise<void> {
  const cleanId = extractSpreadsheetId(spreadsheetId);
  try {
    const activeTitle = sheetTitle || await getFirstSheetTitle(accessToken, cleanId);

    // Format Date & Time matching "June 22, 2026" & "10:52:05 AM"
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const timeStr = now.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });

    // Write to D1 and D2 of the primary sheet tab
    const range = `'${activeTitle}'!D1:D2`;
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cleanId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        range: range,
        majorDimension: "ROWS",
        values: [
          ["UPDATED AS OF:"],
          [`${dateStr}\n${timeStr}`],
        ],
      }),
    });
  } catch (err) {
    console.error("Failed to update dashboard timestamp on D1/D2", err);
  }
}
