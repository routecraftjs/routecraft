/**
 * The one error a surface backend throws that the adapter reads rather
 * than wraps.
 *
 * Kept beside the connection contract rather than in `types.ts`, which
 * stays erasable: a runtime class there would make a type-only module
 * carry code.
 */

/**
 * What a backend's `request` or `notify` rejects with when the connection
 * went away while the call was outstanding.
 *
 * The adapter reports that as the surface disconnecting (`AI1014`) rather
 * than as the person refusing (`AI1016`), because the two have different
 * fixes and only the backend can tell them apart: it knows whether the
 * peer answered or the transport died. A backend that rejects with
 * anything else is read as a refusal, so a backend that never throws this
 * reports every dropped connection as a person saying no.
 */
export class SurfaceDisconnected extends Error {
  constructor(cause: unknown) {
    super("The surface disconnected while the call was outstanding.", {
      cause,
    });
    this.name = "SurfaceDisconnected";
  }
}
