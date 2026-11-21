// One setup for the interface (docs/design/setup.md §1): "This computer"
// (`controller.ts`) and "Another computer" (`remote.ts`) behind the one
// `SetupHost` the bridge calls, sharing one setup slice. The route part of
// the slice, which the status strip and Settings read, is the SSH route's and
// outlives every setup screen.

import {
  initialSetupState,
  type ApprovalPlace,
  type ClawtrateClient,
  type ReadBack,
  type ReadBackRequest,
  type RouteStatus,
  type SetupHost,
  type SetupState,
} from "@clawtrate/core";

import type { SetupController } from "./controller.ts";
import type { RemoteSetup } from "./remote.ts";

/** The setup slice, published whole: the screens' part and the route's. */
export class SetupSlice {
  private main: SetupState = initialSetupState;
  private route: RouteStatus | null = null;
  private readonly client: ClawtrateClient;

  constructor(client: ClawtrateClient) {
    this.client = client;
  }

  setMain(next: SetupState): void {
    this.main = next;
    this.push();
  }

  setRoute(route: RouteStatus | null): void {
    this.route = route;
    this.push();
  }

  private push(): void {
    this.client.setSetup({ ...this.main, route: this.route });
  }
}

export class SetupRouter implements SetupHost {
  private readonly here: SetupController;
  private readonly remote: RemoteSetup | null;

  constructor(here: SetupController, remote: RemoteSetup | null) {
    this.here = here;
    this.remote = remote;
  }

  /** Where the owner approves a request for the gateway at `url`, for the approve command (§9). */
  placeFor(url: string): ApprovalPlace | null {
    return this.remote?.placeFor(url) ?? this.here.placeFor(url);
  }

  /** The read-back after an approval (§9), where the gateway at `url` is a route's or found here. */
  async readBack(url: string, request: ReadBackRequest): Promise<ReadBack | null> {
    return (await this.remote?.readBack(url, request)) ?? (await this.here.readBack(url, request));
  }

  async look(): Promise<void> {
    this.remote?.reset();
    await this.here.look();
  }

  /**
   * Review and Look again after an approval for a gateway set up here (§9):
   * this computer's look for the saved profile alone, checking its address.
   */
  async reviewHere(): Promise<void> {
    this.remote?.reset();
    await this.here.reviewOf(this.here.savedHere());
  }

  cancel(): void {
    if (this.remote?.active) this.remote.cancel();
    else this.here.cancel();
  }

  async connect(): Promise<void> {
    if (this.remote?.active) return this.remote.connect();
    return this.here.connect();
  }

  reset(): void {
    this.here.reset();
    this.remote?.reset();
  }

  async there(destination: string): Promise<void> {
    if (!this.remote) throw new Error("This host doesn't reach another computer over SSH.");
    this.here.reset();
    await this.remote.there(destination);
  }

  async trustKey(): Promise<void> {
    await this.need().trustKey();
  }

  async replaceKey(): Promise<void> {
    await this.need().replaceKey();
  }

  async start(): Promise<void> {
    await this.need().start();
  }

  async retryRoute(): Promise<void> {
    await this.need().retryRoute();
  }

  async removeRoute(): Promise<void> {
    await this.need().removeRoute();
  }

  private need(): RemoteSetup {
    if (!this.remote) throw new Error("This host doesn't reach another computer over SSH.");
    return this.remote;
  }
}
