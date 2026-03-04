import { useAzureMonitor } from "@azure/monitor-opentelemetry";
import appInsights from "applicationinsights";

let initialized = false;

export function initTelemetry() {
  if (initialized) return;

  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  console.log(
    `[telemetry] APPLICATIONINSIGHTS_CONNECTION_STRING ${connectionString ? `present (${connectionString.length} chars)` : "MISSING"}`
  );

  if (!connectionString) {
    console.warn("[telemetry] Skipping Azure Monitor init — no connection string");
    return;
  }

  try {
    // OpenTelemetry auto-instrumentation (dependencies, traces)
    useAzureMonitor({
      azureMonitorExporterOptions: { connectionString },
    });
    console.log("[telemetry] useAzureMonitor initialized (auto-instrumentation)");
  } catch (err: any) {
    console.error("[telemetry] useAzureMonitor() failed:", err?.message ?? err);
  }

  try {
    // Classic SDK for custom events
    appInsights.setup(connectionString)
      .setAutoCollectRequests(false)
      .setAutoCollectPerformance(false, false)
      .setAutoCollectExceptions(false)
      .setAutoCollectDependencies(false)
      .setAutoCollectConsole(false)
      .start();
    console.log("[telemetry] applicationinsights SDK started (custom events)");
  } catch (err: any) {
    console.error("[telemetry] applicationinsights setup failed:", err?.message ?? err);
  }

  initialized = true;
  console.log("[telemetry] Azure Monitor initialized (worker)");
}

/**
 * Send a custom event to Azure Monitor via the classic applicationinsights SDK.
 */
export async function trackEvent(
  name: string,
  properties?: Record<string, string | number | boolean | null | undefined>
) {
  console.log(`[telemetry] trackEvent("${name}") called, initialized=${initialized}`);

  if (!appInsights.defaultClient) {
    console.warn(`[telemetry] trackEvent("${name}") skipped — no defaultClient`);
    return;
  }

  // Convert all values to strings for App Insights custom properties
  const stringProps: Record<string, string> = {};
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (value != null) stringProps[key] = String(value);
    }
  }

  appInsights.defaultClient.trackEvent({ name, properties: stringProps });

  try {
    await appInsights.defaultClient.flush();
    console.log(`[telemetry] trackEvent("${name}") flushed via applicationinsights SDK`);
  } catch (err: any) {
    console.error(`[telemetry] flush failed for "${name}":`, err?.message ?? err);
  }
}
