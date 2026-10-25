/** Pure text segmentation shared by streaming and complete-body synthesis. */
export function splitSpeakableSegments(input: string, final: boolean, idle = false): { ready: string[]; remainder: string } {
  const ready: string[] = [];
  let remainder = input;
  const boundary = /[。！？!?；;\n]/u;
  while (remainder.length > 0) {
    const match = boundary.exec(remainder);
    if (match?.index !== undefined) {
      const end = match.index + match[0].length;
      const segment = remainder.slice(0, end).trim();
      remainder = remainder.slice(end);
      if (segment) ready.push(segment);
      continue;
    }
    if (remainder.length >= 80) {
      ready.push(remainder.slice(0, 80).trim());
      remainder = remainder.slice(80);
      continue;
    }
    if ((final || idle) && remainder.trim()) {
      ready.push(remainder.trim());
      remainder = '';
    }
    break;
  }
  return { ready, remainder };
}
