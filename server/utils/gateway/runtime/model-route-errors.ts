export class ModelRouteError extends Error {
  constructor(
    message: string,
    readonly code = "MODEL_ROUTE_INVALID",
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ModelRouteError";
  }
}

export function assertThreadModelProvider(requested: string | null | undefined, current: string) {
  // Missing/null is an assertion-free update of an existing thread, never a request to adopt the
  // host's current default. The native provider belongs to the thread for its entire lifetime.
  if (requested != null && requested !== current) {
    throw new ModelRouteError(
      "This session uses another model provider. Create a new session to change providers.",
      "MODEL_PROVIDER_MISMATCH",
      409,
    );
  }
}
