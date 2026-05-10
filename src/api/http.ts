const PREVIEW_PORT = "4173";
const FALLBACK_API_ORIGIN = "http://127.0.0.1:8787";

export type ApiLocale = "ar" | "en";

function getConfiguredApiOrigin() {
  const configuredOrigin = (
    import.meta.env.VITE_API_BASE_URL as string | undefined
  )?.trim();
  if (configuredOrigin) {
    return configuredOrigin.replace(/\/$/, "");
  }

  if (typeof window !== "undefined" && window.location.port === PREVIEW_PORT) {
    return FALLBACK_API_ORIGIN;
  }

  return "";
}

export function resolveApiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const apiOrigin = getConfiguredApiOrigin();
  return apiOrigin ? `${apiOrigin}${path}` : path;
}

function buildNonJsonErrorMessage(defaultMessage: string, locale: ApiLocale) {
  return locale === "en"
    ? `${defaultMessage} Make sure the review API server is running or that VITE_API_BASE_URL is configured correctly.`
    : `${defaultMessage} تأكد من تشغيل خادم المراجعة API أو ضبط VITE_API_BASE_URL بشكل صحيح.`;
}

export async function fetchJson<T>(
  path: string,
  init: RequestInit,
  defaultMessage: string,
  locale: ApiLocale = "ar",
): Promise<T> {
  const response = await fetch(resolveApiUrl(path), init);
  const responseText = await response.text();
  const contentType = response.headers.get("content-type") || "";

  let payload: unknown = null;
  if (responseText) {
    if (!contentType.includes("application/json")) {
      throw new Error(buildNonJsonErrorMessage(defaultMessage, locale));
    }

    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(buildNonJsonErrorMessage(defaultMessage, locale));
    }
  }

  if (!response.ok) {
    const errorMessage =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : defaultMessage;
    throw new Error(errorMessage);
  }

  return payload as T;
}
