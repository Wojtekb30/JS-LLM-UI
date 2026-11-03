(() => {
  "use strict";
  // Base64 and localStorage's string quota make large files unsuitable for this vault.
  const MAX_BYTES = 1500000;
  const MAX_FILES = 4;
  const textExtensions = /\.(txt|md|csv|json|jsonl|js|ts|tsx|jsx|html|css|xml|yaml|yml|py|sh|sql|log|toml|ini|c|h|cpp|rs|go|java)$/i;
  const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

  function read(file, asText) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      if (asText) reader.readAsText(file);
      else reader.readAsDataURL(file);
    });
  }

  async function load(files, existing = []) {
    if (files.length + existing.length > MAX_FILES) throw new Error(`Attach at most ${MAX_FILES} files per message.`);
    if ([...files, ...existing].reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) throw new Error("Attachments must total at most 1.5 MB per message to fit in the local vault.");
    const attachments = [];
    for (const file of files) {
      const mimeType = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "");
      const kind = imageTypes.has(mimeType) ? "image" : mimeType === "application/pdf" ? "pdf" : mimeType.startsWith("text/") || textExtensions.test(file.name) ? "text" : "";
      if (!kind) throw new Error(`${file.name}: use a PNG, JPEG, WebP, GIF, PDF, or plain-text/code file.`);
      const attachment = { name: file.name, size: file.size, mimeType: mimeType || "text/plain", kind };
      if (kind === "text") attachment.text = await read(file, true);
      else {
        const dataUrl = await read(file, false);
        attachment.dataUrl = `data:${attachment.mimeType};base64,${dataUrl.split(",")[1]}`;
      }
      attachments.push(attachment);
    }
    return attachments;
  }

  window.ChatAttachments = { load };
})();
