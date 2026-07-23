export function errorMessage(error: unknown, fallback = "操作失败。") {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.trim() ? message : fallback;
  }
  return fallback;
}
