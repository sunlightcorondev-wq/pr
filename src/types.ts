export interface RequisitionItem {
  category: string;
  itemDescription: string;
  quantityRequest: number;
  uom: string;
  purchaseRequestRef?: string;
  chargingDepartment?: string;
  prDateReceived?: string;
  prDateSend?: string;
}

export const CATEGORIES = [
  "ALCOHOLIC DRINKS",
  "BEVERAGES",
  "CHEMICAL",
  "DIESEL / GASOLINE",
  "EQUIPMENT / PARTS",
  "FOOD",
  "LPG GAS",
  "MEDICINE",
  "NON-FOOD",
  "OFFICE SUPPLY",
  "TOOLS & UTENSILS"
] as const;

export const KITCHEN_DEPARTMENTS = ["KITCHEN", "KITCHEN & FNB", "KITCHEN & CAFETERIA", "MAIN KITCHEN"];

export const DEPARTMENT_MAPPING: Record<string, string> = {
  "warehouse": "warehouse_purchasing",
  "purchasing": "warehouse_purchasing",
  "maintenance": "maintenance_engineering",
  "engineering": "maintenance_engineering",
  "kitchen": "kitchen_main",
  "main kitchen": "kitchen_main",
  "kitchen & fnb": "kitchen_main",
  "kitchen & cafeteria": "kitchen_main"
};

export const normalizeDepartment = (dept: string): string => {
  const cleanDept = dept.toLowerCase().replace(/^sghc-/i, "").trim();
  
  for (const key in DEPARTMENT_MAPPING) {
    if (cleanDept.includes(key) || key.includes(cleanDept)) {
      return DEPARTMENT_MAPPING[key];
    }
  }
  return cleanDept;
};


export interface RequisitionScanResult {
  purchaseRequestRef: string;
  chargingDepartment: string;
  prDateReceived?: string;
  prDateSend?: string;
  items: RequisitionItem[];
}

export interface PackingListItem {
  description: string;
  quantityReceived: number;
  uom: string;
  sheetName?: string;
  department?: string;
  sourceFileId?: string;
}

export interface PackingListScanResult {
  supplier?: string;
  voyage?: string;
  propertyRemarks?: string;
  receivedDate?: string;
  purchaseRequestRef?: string;
  chargingDepartment?: string;
  prDateReceived?: string;
  prDateSend?: string;
  items: PackingListItem[];
}

export interface SheetRow {
  rowIndex: number; // 1-indexed row in the spreadsheet
  tabName?: string; // which spreadsheet tab this parsed row loaded from
  purchaseRequestRef: string;
  category: string;
  itemDescription: string;
  quantityRequest: string;
  uomFirst: string;
  prDateReceived: string;
  prDateSend: string;
  chargingDepartment: string;
  status: string;
  corporateRemarks: string;
  receivedDate: string;
  amount: string;
  supplier: string;
  paymentMethods: string;
  quantityReceived: string;
  uomSecond: string;
  propertyRemarks: string;
  voyage: string;
}

export interface MatchCandidate {
  sheetRow: SheetRow;
  similarity: number; // calculated similarity score
  exactRefMatch: boolean;
}

export interface PackingListMatch {
  packingItem: PackingListItem;
  matchedRow: SheetRow | null; // Selected matching row from spreadsheet
  autoMatchCandidates: MatchCandidate[];
  manuallySelectedRow?: SheetRow | null;
}
