/** DXF before AutoCAD 2007 stores strings in the $DWGCODEPAGE encoding */
export function decodeDxf(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 64_000));
  const version = Number(header.match(/\$ACADVER\s+1\s+AC(\d+)/u)?.[1] ?? 0);
  const codepage = header
    .match(/\$DWGCODEPAGE\s+3\s+([^\r\n]+)/u)?.[1]
    .trim()
    .toUpperCase();
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (utf8Bom || version >= 1021 || /UTF-?8/u.test(codepage ?? "")) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (codepage?.startsWith("ANSI_")) {
    const code = codepage.slice(5);
    const legacy: Record<string, string> = {
      "932": "shift_jis",
      "936": "gbk",
      "949": "euc-kr",
      "950": "big5",
    };
    try {
      return new TextDecoder(legacy[code] ?? `windows-${code}`, { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        `Could not read the DXF encoding (${codepage}). Re-save the file as DXF 2007 or newer in UTF-8.`,
      );
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}
