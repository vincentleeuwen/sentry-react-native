import { Span as SpanClass } from '@sentry/core';
import type { EventProcessor, Hub, Integration, Transaction } from '@sentry/types';
import { logger, timestampInSeconds } from '@sentry/utils';
import type { AppStateStatus } from 'react-native';
import { AppState } from 'react-native';

export const BACKGROUND_SPAN_OP = 'app.background';

/**
 * Creates spans for the period of time that the App is in background
 * (not active)
 */
export class BackgroundSpans implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'BackgroundSpans';

  /**
   * @inheritDoc
   */
  public name: string = BackgroundSpans.id;

  private _currentBackgroundStartTimestamp: number | undefined;

  public constructor(private _appState: AppState = AppState) {}

  /**
   * @inheritDoc
   */
  public setupOnce(_: (e: EventProcessor) => void, getCurrentHub: () => Hub): void {
    if (!this._appState.isAvailable || typeof this._appState.addEventListener !== 'function') {
      logger.warn('AppState is not available on this platform, BackgroundSpans Integration will not work.');
      return;
    }

    this._appState.addEventListener('change', (state: AppStateStatus) => {
      if (state === <AppStateStatus>'active' && this._currentBackgroundStartTimestamp) {
        const endTimestamp = timestampInSeconds();
        const hub = getCurrentHub();
        const tx = hub.getScope().getTransaction();

        this._createBackgroundSpan(this._currentBackgroundStartTimestamp, endTimestamp, tx);
        this._currentBackgroundStartTimestamp = undefined;
      } else if (state === <AppStateStatus>'background' && !this._currentBackgroundStartTimestamp) {
        this._currentBackgroundStartTimestamp = timestampInSeconds();
      }
    });
  }

  /**
   * Creates a background span and adds it to the transaction
   * Patches the transaction's finish method to remove trailing background span
   */
  private _createBackgroundSpan(startTimestamp: number, endTimestamp: number, tx: Transaction | undefined): void {
    if (!tx) {
      return;
    }

    tx.startChild({
      startTimestamp,
      description: 'App in background',
      op: BACKGROUND_SPAN_OP,
    }).finish(endTimestamp);

    if ((tx as unknown as Record<string, boolean>).__backgroundSpan === true) {
      return;
    }

    (tx as unknown as Record<string, boolean>).__backgroundSpan = true;
    const originalFinish = tx && tx.finish.bind(tx);
    const beforeTransactionFinish = (endTimestamp?: number): void => {
      const transaction = tx as SpanClass;
      if (!(transaction instanceof SpanClass)) {
        return originalFinish(endTimestamp);
      }

      const spans = transaction.spanRecorder && transaction.spanRecorder.spans;
      if (!spans) {
        return originalFinish(endTimestamp);
      }

      // remove trailing background span
      let trailingSpanIndex: number | undefined;
      let trailingSpan: SpanClass | undefined;
      for (let i = spans.length - 1; i >= 0; i--) {
        const span = spans[i];
        if (
          trailingSpan &&
          typeof span.endTimestamp !== 'undefined' &&
          typeof trailingSpan.endTimestamp !== 'undefined'
        ) {
          if (span.endTimestamp > trailingSpan.endTimestamp) {
            // Update trailing span
            trailingSpanIndex = i;
            trailingSpan = span;
            continue;
          }
        }

        if (!trailingSpan) {
          trailingSpanIndex = i;
          trailingSpan = span;
        }
      }

      if (typeof trailingSpanIndex !== 'undefined' && trailingSpan && trailingSpan.op === BACKGROUND_SPAN_OP) {
        spans.splice(trailingSpanIndex, 1);
        logger.debug('Removing trailing background span', tx.spanId, trailingSpan);
      } else {
        logger.debug('No trailing background span found', tx.spanId);
      }
      delete (tx as unknown as Record<string, boolean>).__backgroundSpan;
      originalFinish(endTimestamp);
    };
    tx.finish = beforeTransactionFinish;
  }
}
