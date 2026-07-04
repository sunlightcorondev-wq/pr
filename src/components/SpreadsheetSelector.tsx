import React, { useState } from "react";
import { Link2, PlusCircle, CheckCircle, RefreshCw, AlertCircle, Eye } from "lucide-react";
import { createSpreadsheet, extractSpreadsheetId } from "../googleSheetsService";

interface SpreadsheetSelectorProps {
  accessToken: string;
  spreadsheetId: string;
  setSpreadsheetId: (id: string) => void;
  onConnected: () => void;
}

export function SpreadsheetSelector({
  accessToken,
  spreadsheetId,
  setSpreadsheetId,
  onConnected,
}: SpreadsheetSelectorProps) {
  const [inputVal, setInputVal] = useState(spreadsheetId);
  const [isCreating, setIsCreating] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleConnect = async (forceId?: string) => {
    const targetId = forceId || extractSpreadsheetId(inputVal);
    if (!targetId) {
      setError("Please paste a valid Google Sheets URL or Spreadsheet ID");
      return;
    }

    setIsConnecting(true);
    setError(null);
    setSuccessMsg(null);

    try {
      // Test fetch row to verify access
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${targetId}?fields=properties.title`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!res.ok) {
        let errMsg = "Permission denied or spreadsheet not found. Ensure you have access and it's shared properly.";
        try {
          const errData = await res.json();
          if (errData?.error?.message) {
            errMsg = `${errData.error.message} (Code: ${res.status})`;
          }
        } catch (_) {}
        throw new Error(errMsg);
      }

      const data = await res.json();
      setSpreadsheetId(targetId);
      localStorage.setItem("requisition_spreadsheet_id", targetId);
      setSuccessMsg(`Successfully connected to: "${data.properties.title}"`);
      onConnected();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to verify spreadsheet access.");
    } finally {
      setIsConnecting(false);
    }
  };

  const handleCreateNew = async () => {
    setIsCreating(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const title = `SGHC PR Monitoring 2026`;
      const { id, url } = await createSpreadsheet(accessToken, title);
      setSpreadsheetId(id);
      setInputVal(url);
      localStorage.setItem("requisition_spreadsheet_id", id);
      setSuccessMsg(`Created & connected to: "${title}"`);
      onConnected();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to auto-create Google Sheet");
    } finally {
      setIsCreating(false);
    }
  };

  const viewSheetUrl = inputVal.includes("docs.google.com")
    ? inputVal
    : `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  return (
    <div className="bg-white border border-slate-200/80 rounded-2xl p-8 shadow-sm max-w-2xl mx-auto my-8">
      <div className="flex items-center gap-4 mb-6">
        <div className="p-3 bg-blue-50 text-blue-600 rounded-xl">
          <Link2 className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-slate-850 font-sans tracking-tight">
            Connect Google Spreadsheet
          </h2>
          <p className="text-xs text-slate-450 mt-1">
            All requisition items and verification statuses will live inside your Google Sheet.
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2.5">
            Spreadsheet URL or Spreadsheet ID
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="https://docs.google.com/spreadsheets/d/.../edit"
              className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-700 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
            />
            <button
              onClick={() => handleConnect()}
              disabled={isConnecting || isCreating}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold text-sm rounded-xl shadow-sm transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {isConnecting ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                "Connect"
              )}
            </button>
          </div>
        </div>

        <div className="relative flex py-2 items-center">
          <div className="flex-grow border-t border-slate-100"></div>
          <span className="flex-shrink mx-4 text-[10px] text-slate-450 font-bold uppercase tracking-wider">
            OR Create a pristine one
          </span>
          <div className="flex-grow border-t border-slate-100"></div>
        </div>

        <button
          onClick={handleCreateNew}
          disabled={isCreating || isConnecting}
          className="w-full py-3.5 border-2 border-dashed border-blue-200 hover:border-blue-400 bg-blue-50/20 hover:bg-blue-50/60 text-blue-700 font-bold text-xs uppercase tracking-wider rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
        >
          {isCreating ? (
            <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
          ) : (
            <PlusCircle className="w-4 h-4 text-blue-600" />
          )}
          Create Brand New Google Spreadsheet Tracker
        </button>

        {error && (
          <div className="p-4 bg-rose-50/55 border border-rose-100 rounded-xl text-sm text-rose-600 flex items-start gap-2.5 animate-fadeIn">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-rose-500" />
            <div>
              <p className="font-bold text-rose-700 text-xs uppercase tracking-wider">Connection Failed</p>
              <p className="text-xs text-rose-600/90 mt-1 font-sans">{error}</p>
            </div>
          </div>
        )}

        {successMsg && (
          <div className="p-4 bg-emerald-50/55 border border-emerald-100 rounded-xl text-sm text-emerald-600 flex items-start gap-2.5 animate-fadeIn">
            <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-emerald-500" />
            <div>
              <p className="font-bold text-emerald-700 text-xs uppercase tracking-wider">Successfully Linked!</p>
              <p className="text-xs text-emerald-600/90 mt-1 font-sans">{successMsg}</p>
              {spreadsheetId && (
                <a
                  href={viewSheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 font-bold underline cursor-pointer"
                >
                  <Eye className="w-3.5 h-3.5" />
                  Open in Google Sheets
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
