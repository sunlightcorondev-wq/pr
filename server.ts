import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

dotenv.config();

const app = express();
const PORT = 3000;

// Increase payload limit because of base64 images
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Initialize Gemini client lazy/properly
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY is not defined. Please add it to Settings -> Secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        }
      }
    });
  }
  return aiClient;
}

const AVAILABLE_MODELS = [
  // Gemini 3.x Family
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-live",
  "gemini-3.5-live-translate",
  "gemini-3-flash-preview", // Current working alias
  
  // Gemini 2.5 Family
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  
  // Gemini 2.0 Family
  "gemini-2.0-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-thinking",
  "gemini-2.0-pro-exp-02-05", // Current working alias
  "gemini-2.0-flash-lite-preview-02-05", // Current working alias

  // 1.5 Family as deep fallbacks
  "gemini-1.5-pro",
  "gemini-1.5-flash",
];

// Retry wrapper with exponential backoff and model fallback
async function callGeminiWithFallback<T>(
  requestFactory: (model: string) => any,
  modelIndex = 0,
  retries = 2
): Promise<any> {
  const model = AVAILABLE_MODELS[modelIndex] || AVAILABLE_MODELS[0];
  const ai = getGeminiClient();

  try {
    return await ai.models.generateContent({
      ...requestFactory(model),
      model,
    });
  } catch (error: any) {
    // Robust error detection for rate limits/quota
    const errorStr = JSON.stringify(error).toUpperCase();
    const message = (error.message || "").toUpperCase();
    const isRateLimit = 
      error.status === "RESOURCE_EXHAUSTED" || 
      error.code === 429 || 
      message.includes("429") || 
      message.includes("RESOURCE_EXHAUSTED") ||
      message.includes("QUOTA") ||
      errorStr.includes("429") ||
      errorStr.includes("RESOURCE_EXHAUSTED") ||
      errorStr.includes("QUOTA");

    // If rate limited, try next model in list immediately
    if (isRateLimit && modelIndex < AVAILABLE_MODELS.length - 1) {
      console.warn(`Model ${model} rate limited or quota exhausted. Switching to ${AVAILABLE_MODELS[modelIndex + 1]}...`);
      // Reset retries for the next model to give it a fair chance
      return callGeminiWithFallback(requestFactory, modelIndex + 1, 2);
    }

    // If still failing and we have retries left, wait and retry
    if (retries > 0) {
      const waitTime = isRateLimit ? 10000 : 2000; // Wait longer for quota issues
      console.warn(`Error with ${model} (RateLimit: ${isRateLimit}), retrying in ${waitTime}ms... (${retries} left)`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return callGeminiWithFallback(requestFactory, modelIndex, retries - 1);
    }

    throw error;
  }
}

// Requisition Form Scanning Endpoint
app.post("/api/scan-requisition", async (req, res) => {
  try {
    const { image, mimeType } = req.body;
    if (!image || !mimeType) {
      return res.status(400).json({ error: "Missing image or mimeType" });
    }

    const result = await callGeminiWithFallback((model) => ({
      contents: [
        {
          inlineData: {
            mimeType,
            data: image,
          },
        },
        "Extract structured requisition details from this image. DO NOT REPEAT MATCHES: Each distinct item in the document should be extracted exactly once. Avoid extracting the same line item multiple times. Keep columns in mind: 'PURCHASE REQUEST REF:' is the Serial code (often inside/above a yellow box or prominently labeled near the top header in a colored or bordered box), 'Charging Department' is the requested/requisition department, 'CATEGORY' is the automatically categorized category based on the item description, 'ITEM DESCRIPTION' is the clear product/particular name, 'QUANTITY REQUEST' is the requested quantity, and 'UOM' is the unit of measure. Categorize each item strictly into one of the following official categories: ALCOHOLIC DRINKS, BEVERAGES, CHEMICAL, DIESEL / GASOLINE, EQUIPMENT / PARTS, FOOD, LPG GAS, MEDICINE, NON-FOOD, OFFICE SUPPLY, TOOLS & UTENSILS.",
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["requisitions"],
          properties: {
            requisitions: {
              type: Type.ARRAY,
              description: "List of requisition forms found in the document. A single document may contain multiple distinct forms (e.g., with different PR numbers or departments).",
              items: {
                type: Type.OBJECT,
                required: ["purchaseRequestRef", "chargingDepartment", "items"],
                properties: {
                  purchaseRequestRef: {
                    type: Type.STRING,
                    description: "The Serial code, requisition number, or Purchase Request Ref, typically shown in a boxed outline, sometimes yellow-bordered or labeled explicitly with PR, REF, Serial, or code near the top.",
                  },
                  chargingDepartment: {
                    type: Type.STRING,
                    description: "The department ordering the items, e.g., Engineering, Kitchen, Deck, Admin, housekeeping.",
                  },
                  prDateReceived: {
                    type: Type.STRING,
                    description: "The date the purchase request was received by the warehouse/purchasing, if visible on the form.",
                  },
                  prDateSend: {
                    type: Type.STRING,
                    description: "The date the purchase request was sent or issued, if visible on the form.",
                  },
                  items: {
                    type: Type.ARRAY,
                    description: "List of items requested in this requisition form",
                    items: {
                      type: Type.OBJECT,
                      required: ["itemDescription", "quantityRequest", "uom", "category"],
                      properties: {
                        itemDescription: {
                          type: Type.STRING,
                          description: "Specific details/particular name of the item. Do not include raw table grid chars.",
                        },
                        quantityRequest: {
                          type: Type.NUMBER,
                          description: "Numerical qty requested.",
                        },
                        uom: {
                          type: Type.STRING,
                          description: "Unit of measure, e.g., pcs, box, rolls, set, meters.",
                        },
                        category: {
                          type: Type.STRING,
                          description: "Select the most appropriate category strictly from the allowed list.",
                          enum: [
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
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }));

    const parsedText = result.text || "{}";
    res.json(JSON.parse(parsedText));
  } catch (error: any) {
    console.error("Error scanning requisition:", error);
    res.status(500).json({ error: error.message || "Failed to parse requisition form" });
  }
});

// Packing List Scanning Endpoint (Verify parts)
app.post("/api/scan-packing-list", async (req, res) => {
  try {
    const { image, mimeType } = req.body;
    if (!image || !mimeType) {
      return res.status(400).json({ error: "Missing image or mimeType" });
    }

    const result = await callGeminiWithFallback((model) => ({
      contents: [
        {
          inlineData: {
            mimeType,
            data: image,
          },
        },
        "Extract structured details of items received from this packing list/invoice/delivery note. DO NOT REPEAT MATCHES: Each item should be extracted only once. Try to extract: list of items received (description, quantity, UOM), supplier if visible, voyage number if visible, any relevant property remarks, and specifically look for a 'Purchase Request Ref' (Serial No/PR #), 'Charging Department', any PR dates listed on the document, and the document/delivery date (receivedDate).",
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["items"],
          properties: {
            supplier: {
              type: Type.STRING,
              description: "Extracted company/sender/supplier name if available on the document, otherwise leave empty.",
            },
            voyage: {
              type: Type.STRING,
              description: "Extracted Voyage reference number or code if available, otherwise empty.",
            },
            receivedDate: {
              type: Type.STRING,
              description: "The date of the packing list or delivery note, often found at the top header.",
            },
            propertyRemarks: {
              type: Type.STRING,
              description: "Any special delivery remarks, conditions of items, carrier, or tracking notes.",
            },
            purchaseRequestRef: {
              type: Type.STRING,
              description: "The PR number or Serial code if found on this packing list.",
            },
            chargingDepartment: {
              type: Type.STRING,
              description: "The department ordering the items if listed.",
            },
            prDateReceived: {
              type: Type.STRING,
              description: "The PR date received if listed.",
            },
            prDateSend: {
              type: Type.STRING,
              description: "The PR date send if listed.",
            },
            items: {
              type: Type.ARRAY,
              description: "List of received items described in this packing list",
              items: {
                type: Type.OBJECT,
                required: ["description", "quantityReceived", "uom"],
                properties: {
                  description: {
                    type: Type.STRING,
                    description: "The description of the received item.",
                  },
                  quantityReceived: {
                    type: Type.NUMBER,
                    description: "The quantity that was actually shipped/received as indicated.",
                  },
                  uom: {
                    type: Type.STRING,
                    description: "Unit of measure of the received item.",
                  },
                },
              },
            },
          },
        },
      },
    }));

    const parsedText = result.text || "{}";
    res.json(JSON.parse(parsedText));
  } catch (error: any) {
    console.error("Error scanning packing list:", error);
    res.status(500).json({ error: error.message || "Failed to parse packing list" });
  }
});

// Serve frontend paths / vite configuration
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server starting on http://localhost:${PORT}`);
  });
}

startServer();
