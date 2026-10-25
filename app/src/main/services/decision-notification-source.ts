import {
  PUBLIC_PROJECTION_CATALOG_VERSION,
  PublicProjectionCatalogPageChain,
  publicProjectionCatalogManifestSchema,
  type PublicDecisionProjection,
  type RuntimeCommand,
  type RuntimeResult
} from '@ariadne/protocol/public';

/** Minimal public metadata. Action tokens and protected payloads never enter notifications. */
export interface DecisionNotificationReference {
  readonly decisionId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly version: number;
}
export interface DecisionNotificationItem extends DecisionNotificationReference {
  readonly kind: PublicDecisionProjection['kind'];
  readonly status: PublicDecisionProjection['status'];
  readonly title: string;
}

export class DecisionNotificationSource {
  constructor(private readonly request: (command: RuntimeCommand) => Promise<RuntimeResult>) {}

  async read(): Promise<readonly DecisionNotificationItem[]> {
    return this.readCatalog('pending');
  }

  /** Clicks revalidate settled as well as pending Decisions using summaries.
   * No action token, question payload or protected detail enters Main. */
  async readCurrent(item: DecisionNotificationReference): Promise<DecisionNotificationItem | null> {
    const found = (await this.readCatalog('all', item.decisionId))[0];
    return found && found.sessionId === item.sessionId && found.runId === item.runId && found.version >= item.version ? found : null;
  }

  private async readCatalog(filter: 'pending' | 'all', findId?: string): Promise<readonly DecisionNotificationItem[]> {
    const result = await this.request({ kind: 'projection.catalog.begin', request: {
      pageContractVersion: PUBLIC_PROJECTION_CATALOG_VERSION, scope: { kind: 'decisions' }, feature: 'decisions', filter
    } });
    if (result.kind !== 'projection.catalog.manifest' || 'status' in result.manifest) {
      throw new Error('decision_notification_snapshot_unavailable');
    }
    const manifest = publicProjectionCatalogManifestSchema.parse(result.manifest);
    if (manifest.scope.kind !== 'decisions' || manifest.scope.workspaceId !== undefined
      || manifest.feature !== 'decisions' || manifest.filter !== filter) {
      throw new Error('decision_notification_manifest_scope_invalid');
    }
    const chain = new PublicProjectionCatalogPageChain(manifest);
    const items: DecisionNotificationItem[] = [];
    let pageCursor: string | undefined;
    do {
      const response = await this.request({ kind: 'projection.catalog.page', request: {
        manifest, limit: 128, ...(pageCursor === undefined ? {} : { pageCursor })
      } });
      if (response.kind !== 'projection.catalog.page_result') throw new Error('decision_notification_page_unavailable');
      const page = await chain.accept(response.page);
      for (const row of page.rows) {
        if (row.feature !== 'decisions') throw new Error('decision_notification_page_scope_invalid');
        const decision = row.dto;
        if (findId !== undefined && decision.decisionId !== findId) continue;
        items.push({ decisionId: decision.decisionId, sessionId: decision.sessionId, runId: decision.runId,
          version: decision.version, kind: decision.kind, status: decision.status,
          title: decision.title });
      }
      if (findId !== undefined && items.length > 0) return items;
      pageCursor = page.nextPageCursor;
    } while (pageCursor !== undefined);
    return items;
  }
}
