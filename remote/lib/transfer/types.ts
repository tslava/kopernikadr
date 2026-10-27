/**
 * What the capture flow needs from the transfer layer (plan Task 10 implements it; tests use a fake).
 * Both calls are fire-and-forget from the capture's point of view: failures belong to Transfer.
 */
export interface Transfer {
  /** A frame was merged as `pending`: download and install it. Ids, not bytes. */
  enqueue(frameId: string, projectId: string): void | Promise<void>;
  /**
   * Ack these frames now. Used for frames that will never be merged (their project is deleted, or
   * the frame is tombstoned). Transfer decides eligibility itself (`ackEligible`).
   * `projectOf` maps frameId -> projectId for frames the store cannot resolve (a deleted project).
   */
  ackNow(frameIds: string[], projectOf?: Readonly<Record<string, string>>): void | Promise<void>;
}
