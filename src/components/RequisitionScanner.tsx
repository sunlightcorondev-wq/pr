import React, { useState, useRef } from "react";
import { Upload, Camera, FileText, Check, AlertTriangle, Plus, Trash2, HelpCircle, Save, Layers, Play, RefreshCw, X, Search } from "lucide-react";
import { RequisitionScanResult, RequisitionItem, CATEGORIES } from "../types";
import { appendRequisitionRows } from "../googleSheetsService";
import { compressImage } from "../utils/imageCompressor";

interface RequisitionScannerProps {
  accessToken: string;
  spreadsheetId: string;
  onSuccess: () => void;
}

interface QueueItem {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  preview: string | null;
  status: "pending" | "compressing" | "scanning" | "done" | "error";
  error: string | null;
}

export function RequisitionScanner({
  accessToken,
  spreadsheetId,
  onSuccess,
}: RequisitionScannerProps) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [activeQueueIdx, setActiveQueueIdx] = useState<number>(-1);
  const [isScanning, setIsScanning] = useState(false);
  const [targetSheet, setTargetSheet] = useState<string>("PURCHASING");
  const [scanResult, setScanResult] = useState<RequisitionScanResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Compress a file and update the queue item
  const updateItemPreview = async (itemId: string, file: File) => {
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
            ? { ...item, status: "error", error: "Failed to open or compress image file" }
            : item
        )
      );
    }
  };

  // Add selected files to the processing queue
  const addFilesToQueue = (files: FileList) => {
    setError(null);
    const validFiles = Array.from(files).filter(
      (file) => file.type.startsWith("image/") || file.type === "application/pdf"
    );

    if (validFiles.length === 0) {
      setError("Please select valid image files or PDFs.");
      return;
    }

    const newItems: QueueItem[] = validFiles.map((file, idx) => {
      const id = `${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 5)}`;
      return {
        id,
        file,
        name: file.name,
        mimeType: file.type,
        preview: null,
        status: "pending",
        error: null,
      };
    });

    const updatedQueue = [...queue, ...newItems];
    setQueue(updatedQueue);

    // Default to selecting the newly added first item if nothing was active
    if (activeQueueIdx === -1) {
      setActiveQueueIdx(queue.length);
    }

    // Trigger background image compression & preview loading for each item
    newItems.forEach((item) => {
      updateItemPreview(item.id, item.file);
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

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    let hadSuccess = false;

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item.status === "done" || item.status === "error") {
        continue; // Skip items already successfully scanned or that failed
      }

      // Automatically select and preview active scanning row
      setActiveQueueIdx(i);
      setQueue((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: "scanning" } : q))
      );

      try {
        let previewData = item.preview;
        let finalMime = item.mimeType;

        // Ensure compression finished
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
        const res = await fetch("/api/scan-requisition", {
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

        const scanData: { requisitions: RequisitionScanResult[] } = await res.json();
        hadSuccess = true;

        const allNewItems: RequisitionItem[] = [];
        
        // Process each requisition found in the file
        for (const req of scanData.requisitions) {
          // Propagate individual metadata into each sub-item
          const processedItems = (req.items || []).map((subItem) => ({
            ...subItem,
            purchaseRequestRef: req.purchaseRequestRef || "N/A",
            chargingDepartment: req.chargingDepartment || "N/A",
            prDateReceived: req.prDateReceived || new Date().toLocaleDateString(),
            prDateSend: req.prDateSend || "",
          }));
          allNewItems.push(...processedItems);
        }

        setScanResult((prev) => {
          // If this is the first scan, initialize with the first requisition's metadata
          if (!prev && scanData.requisitions.length > 0) {
            const first = scanData.requisitions[0];
            return {
              purchaseRequestRef: first.purchaseRequestRef || "N/A",
              chargingDepartment: first.chargingDepartment || "N/A",
              prDateReceived: first.prDateReceived || new Date().toLocaleDateString(),
              prDateSend: first.prDateSend || "",
              items: allNewItems,
            };
          }

          if (!prev) return null;

          // Filter out items that are already in the list (simple duplicate detection)
          const uniqueNewItems = allNewItems.filter(newItem => 
            !prev.items.some(existingItem => 
              existingItem.itemDescription.toLowerCase() === newItem.itemDescription.toLowerCase() &&
              existingItem.quantityRequest === newItem.quantityRequest &&
              existingItem.purchaseRequestRef === newItem.purchaseRequestRef
            )
          );

          if (uniqueNewItems.length === 0) return prev;

          return {
            ...prev,
            items: [...prev.items, ...uniqueNewItems],
          };
        });

        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: "done" } : q))
        );

        // Add a delay between requests to avoid rate limits
        if (i < queue.length - 1) {
          await sleep(3000);
        }
      } catch (err: any) {
        console.error("Batch item scan failure on:", item.name, err);
        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: "error", error: err.message || "Failed to scan" } : q))
        );
      }
    }

    setIsScanning(false);
    if (!hadSuccess && queue.some(q => q.status === "error")) {
      setError("Some or all documents failed to process. Check individual elements in the queue.");
    }
  };

  // Field Edit Handlers
  const handleMetaChange = (field: keyof RequisitionScanResult, val: string) => {
    if (!scanResult) return;
    setScanResult({
      ...scanResult,
      [field]: val,
    });
  };

  const handleItemChange = (index: number, field: keyof RequisitionItem, val: any) => {
    if (!scanResult) return;
    const itemsCopy = [...scanResult.items];
    itemsCopy[index] = {
      ...itemsCopy[index],
      [field]: val,
    };
    setScanResult({
      ...scanResult,
      items: itemsCopy,
    });
  };

  const addItem = (customRef?: string) => {
    const currentRef = customRef || scanResult?.purchaseRequestRef || "MANUAL";
    setScanResult((prev) => {
      const base = prev || { 
        purchaseRequestRef: currentRef, 
        chargingDepartment: "General", 
        prDateReceived: new Date().toLocaleDateString(),
        prDateSend: "",
        items: [] 
      };
      return {
        ...base,
        items: [
          ...base.items,
          { 
            itemDescription: "", 
            quantityRequest: 1, 
            uom: "pcs", 
            category: "OFFICE SUPPLY", 
            purchaseRequestRef: currentRef,
            chargingDepartment: base.chargingDepartment,
            prDateReceived: base.prDateReceived,
            prDateSend: base.prDateSend
          },
        ],
      };
    });
  };

  const removeItem = (idx: number) => {
    if (!scanResult) return;
    const itemsCopy = scanResult.items.filter((_, i) => i !== idx);
    setScanResult({
      ...scanResult,
      items: itemsCopy,
    });
  };

  const resetAll = () => {
    setQueue([]);
    setActiveQueueIdx(-1);
    setScanResult(null);
    setError(null);
  };

  // Save to Google sheet after confirmation
  const handleSaveToSheet = async () => {
    if (!scanResult || !spreadsheetId) return;

    setIsSaving(true);
    setError(null);

    try {
      const rowsToAppend = scanResult.items.map((item) => ({
        purchaseRequestRef: item.purchaseRequestRef || scanResult.purchaseRequestRef || "N/A",
        category: item.category,
        itemDescription: item.itemDescription,
        quantityRequest: String(item.quantityRequest),
        uomFirst: item.uom,
        prDateReceived: item.prDateReceived || scanResult.prDateReceived || new Date().toLocaleDateString(),
        prDateSend: item.prDateSend || scanResult.prDateSend || "",
        chargingDepartment: item.chargingDepartment || scanResult.chargingDepartment || "N/A",
        status: "PENDING",
      }));

      await appendRequisitionRows(
        accessToken,
        spreadsheetId,
        rowsToAppend,
        targetSheet
      );
      resetAll();
      onSuccess();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to append rows to Google Sheets.");
    } finally {
      setIsSaving(false);
    }
  };

  const activeItem = activeQueueIdx !== -1 ? queue[activeQueueIdx] : null;

  return (
    <div className="max-w-6xl mx-auto animate-fadeIn">
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
            accept="image/*,application/pdf"
            multiple
            onChange={handleFileChange}
          />
          <div className="p-5 bg-blue-50 text-blue-600 rounded-2xl shadow-inner">
            <Upload className="w-10 h-10" />
          </div>
          <div className="max-w-sm">
            <p className="text-slate-800 font-extrabold text-xl uppercase tracking-tight font-sans">
              Upload Requisition Slips
            </p>
            <p className="text-slate-450 text-xs mt-2 leading-relaxed">
              Drag & Drop or click to select multiple JPEG, PNG, or PDF files. Batch processing is enabled for high-volume entry.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            <span className="text-[10px] font-bold text-slate-500 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200/60 flex items-center gap-1.5 font-mono">
              <Layers className="w-3.5 h-3.5 text-blue-500" /> Multi-page scanning
            </span>
            <span className="text-[10px] font-bold text-slate-500 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200/60 font-mono">
              AI Serial & Category Classifier
            </span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Sidebar: Queue & Controls */}
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
                          {item.preview ? (
                            <img src={item.preview} className="w-full h-full object-cover rounded-lg" alt="" />
                          ) : (
                            <FileText className="w-5 h-5" />
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

              {/* Target Ledger Selection */}
              <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4">
                <label className="block text-[10px] font-bold uppercase text-slate-400 tracking-widest mb-3">
                  Target Ledger (Sheet Tab)
                </label>
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

              {/* Trigger Scan Button */}
              <button
                onClick={startBatchScan}
                disabled={isScanning || queue.every((q) => q.status === "done")}
                className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-black text-sm rounded-2xl shadow-xl shadow-blue-100/30 transition-all flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed group"
              >
                {isScanning ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    EXTRACTING...
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5 text-blue-200 fill-blue-200 group-hover:scale-110 transition-transform" />
                    {queue.some((q) => q.status === "done") ? "RESCAN QUEUE" : "START BATCH SCAN OCR"}
                  </>
                )}
              </button>

              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*,application/pdf"
                multiple
                onChange={handleFileChange}
              />
            </div>
          </div>

          {/* Right Content: OCR Extracted Results */}
          <div className="lg:col-span-8 space-y-6">
            {isScanning && (
              <div className="bg-white border border-slate-200 rounded-3xl p-12 shadow-sm flex flex-col justify-center items-center space-y-6 animate-pulse min-h-[400px]">
                <RefreshCw className="w-16 h-16 text-blue-500 animate-spin" />
                <div className="text-center">
                  <p className="text-slate-800 text-xl font-bold uppercase tracking-tight font-sans">
                    Analyzing Requisitions...
                  </p>
                  <p className="text-slate-450 text-xs mt-2 max-w-sm mx-auto leading-relaxed">
                    We are reading files sequentially, parsing details, identifying handwriting/tables, and mapping them to official categories.
                  </p>
                </div>
              </div>
            )}

            {!isScanning && !scanResult && !error && (
              <div className="bg-white border border-slate-200/80 rounded-3xl p-12 shadow-sm text-center space-y-6 min-h-[400px] flex flex-col items-center justify-center">
                <div className="w-20 h-20 bg-slate-50 text-slate-300 rounded-full flex items-center justify-center">
                  <HelpCircle className="w-10 h-10" />
                </div>
                <div className="max-w-md">
                  <p className="text-slate-800 text-base font-bold font-sans">Queue Ready</p>
                  <p className="text-slate-450 text-xs mt-2 leading-relaxed">
                    Click <strong className="text-slate-700 uppercase font-mono">Start Batch Scan OCR</strong> on the left to analyze the queued documents and build your combined requisitions report.
                  </p>
                </div>
              </div>
            )}

            {error && (
              <div className="p-8 bg-rose-50 border border-rose-100 rounded-3xl text-rose-600 shadow-sm flex gap-4">
                <AlertTriangle className="w-8 h-8 flex-shrink-0" />
                <div>
                  <p className="font-bold text-rose-800">Scan Warning</p>
                  <p className="text-sm text-rose-600 mt-1 leading-relaxed">{error}</p>
                </div>
              </div>
            )}

            {scanResult && (
              <div className="space-y-6 animate-fadeIn">
                <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">
                  <div className="px-8 py-5 bg-emerald-50/20 border-b border-emerald-100/40 flex justify-between items-center">
                    <div className="flex flex-col">
                      <span className="font-black text-slate-800 flex items-center gap-2 text-xs uppercase tracking-widest font-mono">
                        <Check className="w-5 h-5 text-emerald-500" /> Combined Requisitions List
                      </span>
                      <span className="text-[10px] font-bold text-slate-400 mt-0.5">{scanResult.items.length} Items Parsed</span>
                    </div>
                    <button
                      onClick={() => addItem(`MANUAL-${Math.random().toString(36).substring(2, 7).toUpperCase()}`)}
                      className="px-4 py-2 text-[10px] font-black uppercase tracking-wider border border-blue-200 hover:border-blue-300 bg-white text-blue-700 rounded-xl transition-all flex items-center gap-2 shadow-sm cursor-pointer shadow-blue-50"
                    >
                      <Plus className="w-4 h-4" /> Add Manual Form
                    </button>
                  </div>

                  <div className="p-8 space-y-10">
                    {/* Items grouped by Form (Serial Reference) */}
                    {(() => {
                      const groups: Record<string, RequisitionItem[]> = {};
                      scanResult.items.forEach((item) => {
                        const key = item.purchaseRequestRef || "N/A";
                        if (!groups[key]) groups[key] = [];
                        groups[key].push(item);
                      });

                      return Object.entries(groups).map(([ref, items], groupIdx) => {
                        const firstItem = items[0];
                        return (
                          <div key={groupIdx} className="space-y-6 animate-fadeIn pb-10 border-b border-slate-100 last:border-0 last:pb-0">
                            {/* Form Header */}
                            <div className="bg-slate-50/50 p-6 rounded-2xl border border-slate-100 shadow-sm">
                              <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-100/50">
                                <div className="flex items-center gap-3">
                                  <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
                                    <FileText className="w-5 h-5" />
                                  </div>
                                  <div>
                                    <h5 className="font-bold text-slate-700 text-sm">Form: {ref}</h5>
                                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest font-mono">Requisition Metadata</p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-100">
                                  {items.length} ITEMS DETECTED
                                </div>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                <div>
                                  <label className="block text-[10px] font-bold uppercase text-slate-400 tracking-wider mb-2">
                                    Serial Reference
                                  </label>
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[11px] font-black text-slate-700 bg-amber-50/30 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all uppercase font-mono"
                                    value={ref}
                                    onChange={(e) => {
                                      const newItems = [...scanResult.items];
                                      scanResult.items.forEach((it, idx) => {
                                        if (it.purchaseRequestRef === ref) {
                                          newItems[idx] = { ...it, purchaseRequestRef: e.target.value };
                                        }
                                      });
                                      setScanResult({ ...scanResult, items: newItems });
                                    }}
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-bold uppercase text-slate-400 tracking-wider mb-2">
                                    Charging Dept
                                  </label>
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[11px] font-bold text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
                                    value={firstItem.chargingDepartment || scanResult.chargingDepartment}
                                    onChange={(e) => {
                                      const newItems = [...scanResult.items];
                                      scanResult.items.forEach((it, idx) => {
                                        if (it.purchaseRequestRef === ref) {
                                          newItems[idx] = { ...it, chargingDepartment: e.target.value };
                                        }
                                      });
                                      setScanResult({ ...scanResult, items: newItems });
                                    }}
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-bold uppercase text-slate-400 tracking-wider mb-2">
                                    Date Received
                                  </label>
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[11px] font-bold text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
                                    value={firstItem.prDateReceived || scanResult.prDateReceived}
                                    onChange={(e) => {
                                      const newItems = [...scanResult.items];
                                      scanResult.items.forEach((it, idx) => {
                                        if (it.purchaseRequestRef === ref) {
                                          newItems[idx] = { ...it, prDateReceived: e.target.value };
                                        }
                                      });
                                      setScanResult({ ...scanResult, items: newItems });
                                    }}
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-bold uppercase text-slate-400 tracking-wider mb-2">
                                    Date Send
                                  </label>
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[11px] font-bold text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
                                    value={firstItem.prDateSend || scanResult.prDateSend}
                                    onChange={(e) => {
                                      const newItems = [...scanResult.items];
                                      scanResult.items.forEach((it, idx) => {
                                        if (it.purchaseRequestRef === ref) {
                                          newItems[idx] = { ...it, prDateSend: e.target.value };
                                        }
                                      });
                                      setScanResult({ ...scanResult, items: newItems });
                                    }}
                                  />
                                </div>
                              </div>
                            </div>

                            {/* Group Items Table */}
                            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                              <table className="w-full text-left text-[11px] border-collapse">
                                <thead className="bg-slate-50 text-slate-400 font-bold uppercase tracking-widest border-b border-slate-100 font-mono">
                                  <tr>
                                    <th className="px-3 py-2">Description</th>
                                    <th className="px-3 py-2 text-center w-24">Qty</th>
                                    <th className="px-3 py-2 w-28 text-center">UOM</th>
                                    <th className="px-3 py-2 w-48">Category</th>
                                    <th className="px-3 py-2 w-12"></th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50">
                                  {items.map((item, itemIdx) => {
                                    const realIdx = scanResult.items.findIndex(it => it === item);
                                    return (
                                      <tr key={itemIdx} className="hover:bg-slate-50/50 transition-colors">
                                        <td className="px-3 py-1.5">
                                          <input
                                            type="text"
                                            className="w-full bg-transparent border-none focus:ring-0 font-bold text-slate-700"
                                            value={item.itemDescription}
                                            onChange={(e) => handleItemChange(realIdx, "itemDescription", e.target.value)}
                                          />
                                        </td>
                                        <td className="px-3 py-1.5">
                                          <input
                                            type="number"
                                            className="w-full bg-transparent border-none focus:ring-0 font-black text-slate-900 text-center font-mono"
                                            value={item.quantityRequest}
                                            onChange={(e) => handleItemChange(realIdx, "quantityRequest", parseFloat(e.target.value) || 0)}
                                          />
                                        </td>
                                        <td className="px-3 py-1.5">
                                          <input
                                            type="text"
                                            className="w-full bg-transparent border-none focus:ring-0 font-bold text-slate-700 text-center font-mono"
                                            value={item.uom}
                                            onChange={(e) => handleItemChange(realIdx, "uom", e.target.value)}
                                          />
                                        </td>
                                        <td className="px-3 py-1.5">
                                          <select
                                            className="w-full bg-transparent border-none focus:ring-0 font-black text-blue-700 appearance-none cursor-pointer uppercase tracking-tighter"
                                            value={item.category}
                                            onChange={(e) => handleItemChange(realIdx, "category", e.target.value)}
                                          >
                                            {CATEGORIES.map((cat) => (
                                              <option key={cat} value={cat}>{cat}</option>
                                            ))}
                                          </select>
                                        </td>
                                        <td className="px-3 py-1.5 text-right">
                                          <button
                                            onClick={() => removeItem(realIdx)}
                                            className="text-slate-300 hover:text-rose-500 transition-colors cursor-pointer"
                                          >
                                            <Trash2 className="w-4 h-4" />
                                          </button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                              <div className="p-3 bg-slate-50/30 border-t border-slate-50 flex justify-center">
                                <button
                                  onClick={() => addItem(ref)}
                                  className="text-[10px] font-black text-blue-600 hover:text-blue-700 flex items-center gap-1.5 uppercase tracking-widest transition-all cursor-pointer"
                                >
                                  <Plus className="w-3.5 h-3.5" /> Add item to this form
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>

                  <div className="px-8 py-6 bg-slate-50 border-t border-slate-100 flex justify-end gap-4">
                    <button
                      onClick={resetAll}
                      className="px-6 py-3 border border-slate-200 hover:bg-slate-100 text-slate-500 font-bold text-xs uppercase tracking-widest rounded-2xl transition-all cursor-pointer shadow-sm"
                    >
                      Discard All
                    </button>
                    <button
                      onClick={handleSaveToSheet}
                      disabled={isSaving || scanResult.items.length === 0}
                      className="px-8 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs uppercase tracking-widest rounded-2xl shadow-xl shadow-emerald-100 transition-all flex items-center gap-2.5 cursor-pointer disabled:opacity-50"
                    >
                      {isSaving ? (
                        <>
                          <RefreshCw className="w-5 h-5 animate-spin" />
                          SAVING ENTRIES...
                        </>
                      ) : (
                        <>
                          <Save className="w-5 h-5" />
                          Push to Linked Ledger ({scanResult.items.length})
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
