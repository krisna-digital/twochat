// Memperkecil foto dan mengubahnya ke JPEG di sisi klien (juga membuang metadata EXIF seperti lokasi GPS).
async function loadViaImg(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // revoke setelah decode selesai; gambar sudah ada di memori
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function resizeToJpeg(file, maxDim = 1280, quality = 0.82) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    src = await loadViaImg(file);
  }
  const sw = src.width || src.naturalWidth;
  const sh = src.height || src.naturalHeight;
  if (!sw || !sh) throw new Error('IMAGE_INVALID');
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.drawImage(src, 0, 0, w, h);
  if (typeof src.close === 'function') src.close();
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('IMAGE_ENCODE'))), 'image/jpeg', quality);
  });
  return { blob, w, h };
}
