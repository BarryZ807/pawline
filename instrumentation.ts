export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { healthProbe } = await import("./src/domain/monitor");
    const root = globalThis as unknown as {
      pawlineMonitor?: ReturnType<typeof setInterval>;
    };
    if (!root.pawlineMonitor) {
      root.pawlineMonitor = setInterval(() => void healthProbe(), 3000);
      root.pawlineMonitor.unref();
      void healthProbe();
    }
  }
}
