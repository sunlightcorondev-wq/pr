/**
 * Compresses an image file (JPEG, PNG, etc.) to a reasonable size and quality
 * for fast and clear OCR scanning with Gemini.
 */
export async function compressImage(
  file: File,
  maxDimension: number = 1600,
  quality: number = 0.8
): Promise<{ dataUrl: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    // If not an image (e.g., application/pdf), read natively
    if (!file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({ dataUrl: reader.result as string, mimeType: file.type });
      };
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
      return;
    }

    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(img.src);

      let width = img.width;
      let height = img.height;

      // Downscale if exceeds maxDimension
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        // Canvas rendering failed, fall back to native reader
        const reader = new FileReader();
        reader.onload = () => {
          resolve({ dataUrl: reader.result as string, mimeType: file.type });
        };
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(file);
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);

      // Save as image/jpeg for smaller file size (vs png)
      const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
      const dataUrl = canvas.toDataURL(mime, quality);
      resolve({ dataUrl, mimeType: mime });
    };

    img.onerror = () => {
      // Image load failed, fall back to native reader
      const reader = new FileReader();
      reader.onload = () => {
        resolve({ dataUrl: reader.result as string, mimeType: file.type });
      };
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    };
  });
}
