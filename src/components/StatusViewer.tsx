import React, { useState, useEffect } from "react";
import { Search, Loader2, RefreshCw, AlertCircle, Trash2, Eye, ShieldAlert, CheckCircle, Clock, X, Ship, Calendar, Share2, Copy } from "lucide-react";
import { SheetRow } from "../types";
import { fetchSpreadsheetRows, deleteSpreadsheetRow, updateSpreadsheetRow, batchUpdateSpreadsheetRows, getAllSheetTitles, batchUpdateCorporateRemarks, copyFileToNewOwner } from "../googleSheetsService";

const getStatusColorClass = (status: string) => {
  const s = (status || "").toUpperCase();
  switch (s) {
    case "RECEIVED":
      return "bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-200/80";
    case "SERVED":
      return "bg-indigo-100 text-indigo-800 border-indigo-200 hover:bg-indigo-200/80";
    case "PARTIAL":
      return "bg-sky-100 text-sky-800 border-sky-200 hover:bg-sky-200/80";
    case "ON HOLD":
      return "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200/80";
    case "CANCELLED":
      return "bg-rose-100 text-rose-800 border-rose-200 hover:bg-rose-200/80";
    default:
      return "bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-200/80";
  }
};

interface StatusViewerProps {
  accessToken: string;
  spreadsheetId: string;
  refreshTrigger: number;
}

export function StatusViewer({
  accessToken,
  spreadsheetId,
  refreshTrigger,
}: StatusViewerProps) {
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [targetSheet, setTargetSheet] = useState<string>("PURCHASING");
  const [availableSheets, setAvailableSheets] = useState<string[]>(["PURCHASING", "OPERATIONS"]);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  // State for the Manual Receiving Modal
  const [receivingRow, setReceivingRow] = useState<SheetRow | null>(null);
  const [rcvVoyage, setRcvVoyage] = useState("");
  const [rcvQty, setRcvQty] = useState("");
  const [rcvSupplier, setRcvSupplier] = useState("");
  const [rcvRemarks, setRcvRemarks] = useState("");
  const [rcvDate, setRcvDate] = useState("");
  const [rcvStatus, setRcvStatus] = useState("RECEIVED");
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // State for Transfer Ownership
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [transferEmail, setTransferEmail] = useState("");
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferTitle, setTransferTitle] = useState("");

  const loadData = async () => {
    if (!spreadsheetId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSpreadsheetRows(accessToken, spreadsheetId, targetSheet);
      setRows(data);
    } catch (err: any) {
      console.error(err);
      setError(
        err.message || "Failed to load worksheet rows. Ensure sheet has correct headers and isn't deleted."
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const fetchSheets = async () => {
      if (accessToken && spreadsheetId) {
        const titles = await getAllSheetTitles(accessToken, spreadsheetId);
        if (titles.length > 0) {
          setAvailableSheets(titles);
          // If current targetSheet is not in the new titles, switch to the first one
          if (!titles.includes(targetSheet)) {
            setTargetSheet(titles[0]);
          }
        }
      }
    };
    fetchSheets();
  }, [accessToken, spreadsheetId]);

  useEffect(() => {
    loadData();
  }, [spreadsheetId, reloadTrigger, refreshTrigger, targetSheet]);

  const handleDelete = async (row: SheetRow) => {
    try {
      await deleteSpreadsheetRow(accessToken, spreadsheetId, row.rowIndex, row.tabName);
      loadData();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to delete row.");
    }
  };

  const handleStatusChange = async (row: SheetRow, newStatus: string) => {
    const s = newStatus.toUpperCase();
    if (s === "RECEIVED" || s === "PARTIAL" || s === "SERVED") {
      setReceivingRow(row);
      setRcvVoyage(row.voyage || "");
      
      const reqVal = parseFloat(row.quantityRequest) || 0;
      const rcvVal = parseFloat(row.quantityReceived) || 0;
      const remaining = Math.max(0, reqVal - rcvVal);
      setRcvQty(remaining > 0 ? String(remaining) : (row.quantityRequest || ""));
      
      setRcvSupplier(row.supplier || "");
      setRcvRemarks(row.propertyRemarks || "");
      setRcvDate(row.receivedDate || new Date().toLocaleDateString());
      setRcvStatus(s);
    } else {
      setLoading(true);
      setError(null);
      try {
        await updateSpreadsheetRow(accessToken, spreadsheetId, row.rowIndex, {
          status: s,
          quantityReceived: "",
          receivedDate: "",
          supplier: "",
          propertyRemarks: "",
          voyage: "",
        }, row.tabName);
        await loadData();
      } catch (err: any) {
        console.error(err);
        setError(`Failed to update status to ${newStatus}.`);
      } finally {
        setLoading(false);
      }
    }
  };

  const handleConfirmReceive = async () => {
    if (!receivingRow) return;
    setIsUpdatingStatus(true);
    try {
      const existingRcv = parseFloat(receivingRow.quantityReceived) || 0;
      const enteredRcv = parseFloat(rcvQty) || 0;
      const newTotal = existingRcv + enteredRcv;
      
      const reqVal = parseFloat(receivingRow.quantityRequest) || 0;
      // Use the explicitly selected status if provided, else auto-calculate
      const autoStatus = newTotal >= reqVal ? "RECEIVED" : "PARTIAL";
      const finalStatus = rcvStatus || autoStatus;

      await updateSpreadsheetRow(accessToken, spreadsheetId, receivingRow.rowIndex, {
        status: finalStatus,
        quantityReceived: String(newTotal),
        receivedDate: rcvDate || new Date().toLocaleDateString(),
        supplier: rcvSupplier,
        propertyRemarks: rcvRemarks,
        voyage: rcvVoyage,
        corporateRemarks: (finalStatus === "RECEIVED" || finalStatus === "SERVED") ? "DELIVERED" : receivingRow.corporateRemarks,
      }, receivingRow.tabName);
      setReceivingRow(null);
      loadData();
    } catch (err: any) {
      console.error(err);
      setError("Failed to update receiving information on Google Sheets.");
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleSyncMarks = async () => {
    if (!accessToken || !spreadsheetId || rows.length === 0) {
      if (rows.length === 0) alert("No data rows loaded to sync.");
      return;
    }
    
    // Find rows that are RECEIVED or SERVED but missing "DELIVERED" mark in Corporate Remarks (Column J)
    const missingMarks = rows.filter(row => {
      const status = (row.status || "").toString().trim().toUpperCase();
      const remarks = (row.corporateRemarks || "").toString().trim().toUpperCase();
      
      // Be flexible with status - anything containing "RECEIVED" or "SERVED"
      const isReceived = status.includes("RECEIVED") || status.includes("SERVED");
      const needsDeliveredMark = !remarks.includes("DELIVERED");
      
      return isReceived && needsDeliveredMark;
    });

    if (missingMarks.length === 0) {
      alert(`No items in "${targetSheet}" need a 'DELIVERED' mark.\n\nChecked ${rows.length} rows.\nCriteria: Status contains 'RECEIVED'/'SERVED' and Corporate Remarks does not contain 'DELIVERED'.`);
      return;
    }

    const confirmMsg = `Found ${missingMarks.length} items in "${targetSheet}" marked as RECEIVED/SERVED but missing 'DELIVERED' in Corporate column.\n\nItems like:\n${missingMarks.slice(0, 5).map(m => `- ${m.itemDescription}`).join("\n")}${missingMarks.length > 5 ? "\n..." : ""}\n\nSync these ${missingMarks.length} items to 'DELIVERED' now?`;
    
    if (!confirm(confirmMsg)) return;

    setIsSyncing(true);
    try {
      const updates = missingMarks.map(row => ({
        rowIndex: row.rowIndex,
        tabName: row.tabName || targetSheet,
        value: "DELIVERED"
      }));

      await batchUpdateCorporateRemarks(accessToken, spreadsheetId, updates);
      alert(`Successfully marked ${updates.length} items as 'DELIVERED' in the spreadsheet.`);
      await loadData(); // Refresh the list
    } catch (err: any) {
      console.error("Sync failed:", err);
      alert(`Sync failed: ${err.message || "Unknown error"}. Check console for details.`);
    } finally {
      setIsSyncing(false);
    }
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

  // Searching & Filtering
  const filteredRows = rows.filter((r) => {
    const matchesSearch =
      r.itemDescription.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.purchaseRequestRef.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.chargingDepartment.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.supplier.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = (() => {
      if (statusFilter === "ALL") return true;
      return r.status.toUpperCase() === statusFilter.toUpperCase();
    })();

    return matchesSearch && matchesStatus;
  });

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden my-3">
      {/* Header controls */}
      <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row gap-3 items-center justify-between bg-slate-50/50">
        <div className="space-y-3 w-full">
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-xs font-bold text-slate-800">Requisitions & Receiving Ledger</h3>
              <p className="text-[10px] text-slate-400 mt-0.5">Live view fetched directly from Linked Spreadsheet</p>
            </div>
            <div className="flex items-center gap-3">
              {/* Sheet Switcher */}
              <div className="flex bg-slate-200/60 p-1 rounded-lg gap-1 overflow-x-auto max-w-xs custom-scrollbar scrollbar-hide">
                {availableSheets.map((sheet) => (
                  <button
                    key={sheet}
                    onClick={() => setTargetSheet(sheet)}
                    className={`px-3 py-1.5 text-[10px] font-bold rounded-md transition-all whitespace-nowrap ${
                      targetSheet === sheet
                        ? "bg-white text-sky-700 shadow-sm"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {sheet}
                  </button>
                ))}
              </div>

              {/* Transfer Button - High Prominence */}
              <button
                onClick={() => {
                  setIsTransferModalOpen(true);
                  setTransferTitle(`Copy of Sunlight Purchasing - ${new Date().toLocaleDateString()}`);
                }}
                disabled={loading || isTransferring}
                className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all cursor-pointer text-[10px] font-extrabold uppercase tracking-widest whitespace-nowrap active:scale-95"
              >
                <Share2 className="w-3.5 h-3.5" />
                <span>Transfer File</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col md:flex-row gap-2 w-full">
            {/* Search */}
            <div className="relative flex-1 md:w-64">
              <Search className="absolute left-3 top-2.5 w-4.5 h-4.5 text-slate-400" />
              <input
                type="text"
                placeholder="Search ref, item, department..."
                className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-xs w-full bg-white focus:outline-none focus:ring-2 focus:ring-sky-500/25"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            {/* Status filter */}
            <select
              className="px-3 py-2 border border-slate-200 rounded-lg text-xs bg-white text-slate-700 focus:outline-none font-medium"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="ALL">All Statuses</option>
              <option value="PENDING">Pending</option>
              <option value="PARTIAL">Partial</option>
              <option value="RECEIVED">Received</option>
              <option value="SERVED">Served</option>
              <option value="ON HOLD">On Hold</option>
              <option value="CANCELLED">Cancelled</option>
            </select>

            {/* Reload button */}
            <button
              onClick={() => setReloadTrigger((prev) => prev + 1)}
              disabled={loading}
              className="p-2 border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-500 hover:text-slate-700 transition-all cursor-pointer"
              title="Refresh database records"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin text-sky-600" : ""}`} />
            </button>

            <button
              onClick={handleSyncMarks}
              disabled={loading || isSyncing}
              className={`flex items-center gap-2 px-3 py-2 border rounded-lg transition-all cursor-pointer text-[10px] font-bold uppercase tracking-wider ${
                isSyncing 
                  ? "bg-amber-50 border-amber-200 text-amber-600" 
                  : "bg-white border-slate-200 text-slate-500 hover:border-amber-200 hover:text-amber-600 hover:bg-amber-50"
              }`}
              title="Fix 'RECEIVED' items missing 'DELIVERED' mark"
            >
              {isSyncing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Syncing...</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
                  <span>Sync Marks</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="p-16 flex flex-col justify-center items-center space-y-3">
          <Loader2 className="w-8 h-8 text-sky-600 animate-spin" />
          <p className="text-sm text-slate-550">Querying real-time Google Sheet records...</p>
        </div>
      ) : error ? (
        <div className="p-10 text-center space-y-3">
          <div className="inline-flex p-3 bg-rose-50 text-rose-600 rounded-full">
            <AlertCircle className="w-6 h-6" />
          </div>
          <p className="text-sm text-rose-700 font-medium">{error}</p>
          <button
            onClick={() => setReloadTrigger((prev) => prev + 1)}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white font-medium text-xs rounded-lg cursor-pointer"
          >
            Retry Connection
          </button>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="p-16 text-center text-slate-400 space-y-2">
          <p className="text-sm">No items matching your select criteria were found.</p>
          <p className="text-xs">Try clearing search terms or scan new requisition slips above.</p>
        </div>
      ) : (
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-left border-collapse table-fixed">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/30 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                <th className="py-0.5 px-0.5 md:px-1 w-[16%] min-w-[130px]">PR Ref</th>
                <th className="py-0.5 px-0.5 md:px-1 w-[10%] min-w-[80px]">Category</th>
                <th className="py-0.5 px-0.5 md:px-1 w-[35%] min-w-[200px]">Item Particulars</th>
                <th className="py-0.5 px-0.5 md:px-1 w-[14%] min-w-[100px]">Req (Delivered)</th>
                <th className="py-0.5 px-0.5 md:px-1 w-[11%] min-w-[85px]">Dept</th>
                <th className="py-0.5 px-0.5 md:px-1 w-[10%] min-w-[95px]">Status</th>
                <th className="py-0.5 px-0.5 md:px-1 text-right w-[4%] min-w-[60px]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-[10.5px] lg:text-[11px] text-slate-600">
              {filteredRows.map((row) => (
                <tr
                  key={row.rowIndex}
                  className="hover:bg-slate-50/40 transition-all cursor-default"
                >
                  <td className="py-0.5 px-0.5 md:px-1 font-mono text-slate-700 font-bold bg-amber-50/10 whitespace-nowrap text-[10px] truncate">
                    {row.purchaseRequestRef || <span className="text-slate-350">None</span>}
                  </td>
                  <td className="py-0.5 px-0.5 md:px-1 truncate">
                    <span className="px-1 py-0.5 bg-slate-100 text-slate-600 rounded-full font-bold text-[8px] uppercase tracking-tight">
                      {row.category || "General"}
                    </span>
                  </td>
                  <td className="py-0.5 px-0.5 md:px-1">
                    <div className="font-semibold text-slate-800 break-words leading-none text-[11px]" title={row.itemDescription}>
                      {row.itemDescription}
                    </div>
                    {row.status.toUpperCase() === "RECEIVED" && (
                      <div className="flex flex-wrap gap-1 mt-0.5 text-[8.5px] text-slate-500 font-normal">
                        {row.voyage && (
                          <span className="inline-flex items-center gap-0.5 bg-sky-50 text-sky-700 px-0.5 py-0.5 rounded border border-sky-100/50">
                            <Ship className="w-1.5 h-1.5" /> Voy: {row.voyage}
                          </span>
                        )}
                        {row.supplier && (
                          <span className="inline-flex items-center gap-0.5 bg-indigo-50 text-indigo-700 px-0.5 py-0.5 rounded border border-indigo-100/50">
                            Vendor: {row.supplier}
                          </span>
                        )}
                        {row.receivedDate && (
                          <span className="inline-flex items-center gap-0.5 bg-emerald-50 text-emerald-700 px-0.5 py-0.5 rounded border border-emerald-100/50">
                            <Calendar className="w-1.5 h-1.5" /> Date: {row.receivedDate}
                          </span>
                        )}
                        {row.propertyRemarks && (
                          <span className="inline-flex items-center gap-0.5 bg-slate-50 text-slate-600 px-0.5 py-0.5 rounded border border-slate-100 max-w-[120px] truncate" title={row.propertyRemarks}>
                            Rem: {row.propertyRemarks}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-0.5 px-0.5 md:px-1 font-medium whitespace-nowrap text-[10.5px]">
                    <div>{row.quantityRequest} {row.uomFirst}</div>
                    {row.quantityReceived && (
                      <span className="text-emerald-600 block text-[8.5px] font-bold">
                        Rcvd: {row.quantityReceived} {row.uomSecond || row.uomFirst}
                      </span>
                    )}
                  </td>
                  <td className="py-0.5 px-0.5 md:px-1 whitespace-nowrap font-medium text-slate-500 text-[10.5px] truncate">{row.chargingDepartment}</td>
                  <td className="py-0.5 px-0.5 md:px-1 whitespace-nowrap">
                    <div className="relative inline-block">
                      <select
                        value={row.status.toUpperCase() || "PENDING"}
                        onChange={(e) => handleStatusChange(row, e.target.value)}
                        className={`appearance-none pl-1.5 pr-4 py-0.5 rounded-full text-[8.5px] font-extrabold uppercase transition-all tracking-wide border cursor-pointer focus:outline-none focus:ring-1 focus:ring-sky-500/30 ${
                          getStatusColorClass(row.status)
                        }`}
                      >
                        <option value="PENDING" className="bg-white text-slate-800 font-medium">Pending</option>
                        <option value="PARTIAL" className="bg-white text-slate-800 font-medium">Partial</option>
                        <option value="RECEIVED" className="bg-white text-slate-800 font-medium">Received</option>
                        <option value="SERVED" className="bg-white text-slate-800 font-medium">Served</option>
                        <option value="ON HOLD" className="bg-white text-slate-800 font-medium">On Hold</option>
                        <option value="CANCELLED" className="bg-white text-slate-800 font-medium">Cancelled</option>
                      </select>
                      <span className="absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none text-slate-500/80">
                        <svg className="w-1.5 h-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M19 9l-7 7-7-7" />
                        </svg>
                      </span>
                    </div>
                  </td>
                  <td className="py-0.5 px-0.5 md:px-1 text-right whitespace-nowrap">
                    <button
                      onClick={() => handleDelete(row)}
                      className="p-1 text-rose-500 hover:bg-rose-50 rounded-full transition-all cursor-pointer inline-flex items-center justify-center"
                      title="Delete permanently"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Manual Receiving Modal Overlay */}
      {receivingRow && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-2xl max-w-lg w-full shadow-2xl border border-slate-100 overflow-hidden transform scale-100 transition-all">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-150 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg">
                  <CheckCircle className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-slate-800 text-sm">Enter Receiving Details</h4>
                  <p className="text-[10px] text-slate-400">Populate Ledger and Voyage Data</p>
                </div>
              </div>
              <button
                onClick={() => setReceivingRow(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Contents */}
            <div className="p-6 space-y-4">
              {/* Item Info Box */}
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-150 text-xs text-slate-600 space-y-1">
                <div>
                  <span className="font-bold text-slate-500 uppercase text-[9px] tracking-wide block">Item to Receive</span>
                  <span className="font-semibold text-slate-800 text-sm">{receivingRow.itemDescription}</span>
                </div>
                <div className="flex justify-between pt-1">
                  <span>PR Ref: <strong className="text-slate-700">{receivingRow.purchaseRequestRef || "N/A"}</strong></span>
                  <span>Requested: <strong className="text-slate-700">{receivingRow.quantityRequest} {receivingRow.uomFirst}</strong></span>
                </div>
              </div>

                {/* Form Input fields */}
                <div className="space-y-3.5">
                  <div className="grid grid-cols-2 gap-3">
                    {/* Voyage # Input (User Request) */}
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1 flex items-center gap-1">
                        <Ship className="w-3.5 h-3.5 text-sky-500" /> Voyage # <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="text"
                        required
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-sky-500 focus:outline-none"
                        value={rcvVoyage}
                        onChange={(e) => setRcvVoyage(e.target.value)}
                        placeholder="Voyage #"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">
                        Quantity Received
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-sky-500 focus:outline-none"
                        value={rcvQty}
                        onChange={(e) => setRcvQty(e.target.value)}
                        placeholder="e.g. 5"
                      />
                    </div>
                  </div>

                  {/* Grid for Status and Date */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">
                        Mark Status As
                      </label>
                      <select
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-sky-500 focus:outline-none bg-white font-medium"
                        value={rcvStatus}
                        onChange={(e) => setRcvStatus(e.target.value)}
                      >
                        <option value="RECEIVED">RECEIVED (Default)</option>
                        <option value="SERVED">SERVED</option>
                        <option value="PARTIAL">PARTIAL</option>
                        <option value="PENDING">PENDING</option>
                        <option value="ON HOLD">ON HOLD</option>
                        <option value="CANCELLED">CANCELLED</option>
                      </select>
                    </div>
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1 flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5 text-emerald-500" /> Date Received
                    </label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-sky-500 focus:outline-none"
                      value={rcvDate}
                      onChange={(e) => setRcvDate(e.target.value)}
                      placeholder="e.g. 6/22/2026"
                    />
                  </div>
                </div>

                {/* Supplier Input */}
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">
                    Supplier / Vendor
                  </label>
                  <input
                    type="text"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-sky-500 focus:outline-none"
                    value={rcvSupplier}
                    onChange={(e) => setRcvSupplier(e.target.value)}
                    placeholder="e.g. ABC Trading Co."
                  />
                </div>

                {/* Property Remarks Input */}
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">
                    Property Remarks
                  </label>
                  <input
                    type="text"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-sky-500 focus:outline-none"
                    value={rcvRemarks}
                    onChange={(e) => setRcvRemarks(e.target.value)}
                    placeholder="e.g. Checked & verified intact"
                  />
                </div>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setReceivingRow(null)}
                className="px-4 py-1.5 border border-slate-200 text-slate-600 hover:bg-slate-100 rounded-lg text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmReceive}
                disabled={isUpdatingStatus}
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg text-xs cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
              >
                {isUpdatingStatus ? (
                  <>
                    <span className="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                    Saving...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-3.5 h-3.5" /> Save Received Status
                  </>
                )}
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
                  <p className="text-[10px] text-slate-400">Clone & move to a new owner</p>
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
                <p className="mt-1">If the email is outside your domain, they will be added as an <strong>Editor</strong> with full permissions instead.</p>
              </div>

              <div className="space-y-3.5">
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">New Owner Email</label>
                  <input
                    type="email"
                    placeholder="user@example.com"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    value={transferEmail}
                    onChange={(e) => setTransferEmail(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Copy Name (Optional)</label>
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
