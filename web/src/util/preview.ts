// Read a picked file's bytes for the analysis worker.
export async function readBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}
