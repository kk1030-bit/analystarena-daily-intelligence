export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`请求正文不得超过 ${maxBytes} 字节`);
    this.name = "RequestBodyTooLargeError";
  }
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RequestBodyTooLargeError(maxBytes);

  const reader = request.body?.getReader();
  if (!reader) return JSON.parse("") as unknown;

  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError(maxBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}
