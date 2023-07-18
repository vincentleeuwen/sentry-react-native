import {
  EventHint,
  EventProcessor,
  Exception,
  ExtendedError,
  Hub,
  Integration,
  StackParser,
  Event,
  StackFrame,
} from '@sentry/types';
import { isInstanceOf } from '@sentry/utils';

const DEFAULT_KEY = 'cause';
const DEFAULT_LIMIT = 5;

interface LinkedErrorsOptions {
  key: string;
  limit: number;
}

export class NativeLinkedErrors implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'NativeLinkedErrors';

  /**
   * @inheritDoc
   */
  public name: string = NativeLinkedErrors.id;

  /**
   * @inheritDoc
   */
  private readonly _key: LinkedErrorsOptions['key'];

  /**
   * @inheritDoc
   */
  private readonly _limit: LinkedErrorsOptions['limit'];

  /**
   * @inheritDoc
   */
  public constructor(options: Partial<LinkedErrorsOptions> = {}) {
    this._key = options.key || DEFAULT_KEY;
    this._limit = options.limit || DEFAULT_LIMIT;
  }

  /**
   * @inheritDoc
   */
  public setupOnce(
    addGlobalEventProcessor: (callback: EventProcessor) => void,
    getCurrentHub: () => Hub,
  ): void {
    const client = getCurrentHub().getClient();
    if (!client) {
      return;
    }

    addGlobalEventProcessor((event: Event, hint?: EventHint) => {
      const self = getCurrentHub().getIntegration(NativeLinkedErrors);
      return self
        ? this._handler(client.getOptions().stackParser, self._key, self._limit, event, hint)
        : event;
    });
  }

  /**
   * @inheritDoc
   */
  public _handler(
    parser: StackParser,
    key: string,
    limit: number,
    event: Event,
    hint?: EventHint,
  ): Event | null {
    if (!event.exception || !event.exception.values || !hint || !isInstanceOf(hint.originalException, Error)) {
      return event;
    }
    const linkedErrors = this._walkErrorTree(parser, limit, hint.originalException as ExtendedError, key);
    event.exception.values = [...linkedErrors, ...event.exception.values];
    return event;
  }

  /**
   * @inheritDoc
   */
  public _walkErrorTree(
    parser: StackParser,
    limit: number,
    error: ExtendedError,
    key: string,
    stack: Exception[] = [],
  ): Exception[] {
    if (!isInstanceOf(error[key], Error) || stack.length + 1 >= limit) {
      return stack;
    }

    const linkedError = error[key];
    let exception: Exception;
    if ('stackElements' in linkedError) {
      // isJavaException
      exception = exceptionFromJavaStackElements(linkedError);
    } else if ('stackSymbols' in linkedError) {
      // isObjCException symbolicated by local debug symbols
      exception = exceptionFromAppleStackSymbols(linkedError);
    } else if ('stackReturnAddresses' in linkedError) {
      // isObjCException
      exception = exceptionFromAppleStackReturnAddresses(linkedError);
    } else {
      exception = exceptionFromError(parser, error[key]);
    }

    return this._walkErrorTree(parser, limit, error[key], key, [exception, ...stack]);
  }
}

export function exceptionFromJavaStackElements(
  javaThrowable: {
    name: string;
    message: string;
    stackElements: {
      className: string;
      fileName: string;
      methodName: string;
      lineNumber: number;
    }[],
  },
): Exception {
  return {
    type: javaThrowable.name,
    value: javaThrowable.message,
    stacktrace: {
      frames: javaThrowable.stackElements.map(stackElement => ({
        platform: 'java',
        module: stackElement.className,
        filename: stackElement.fileName,
        lineno: stackElement.lineNumber,
        function: stackElement.methodName,
      })),
    },
  };
}

export function exceptionFromAppleStackSymbols(
  objCException: {
    name: string;
    message: string;
    stackSymbols: string[];
  },
): Exception {
  return {
    type: objCException.name,
    value: objCException.message,
    stacktrace: {
      frames: objCException.stackSymbols.map(stackSymbol => {
        const addrStartIndex = stackSymbol.indexOf(' 0x') + 1;
        const addrEndIndex = stackSymbol.indexOf(' ', addrStartIndex);
        const pkg = stackSymbol.substring(5, addrStartIndex).trimEnd();
        const addr = stackSymbol.substring(addrStartIndex + 2, addrEndIndex - 1);
        const functionEndIndex = stackSymbol.indexOf(' + ', addrEndIndex);
        const func = stackSymbol.substring(addrEndIndex + 1, functionEndIndex);
        return {
          platform: 'cocoa',
          package: pkg,
          function: func,
          instruction_addr: addr,
        };
      }),
    },
  };
}

export function exceptionFromAppleStackReturnAddresses(
  objCException: {
    name: string;
    message: string;
    stackReturnAddresses: number[];
  },
): Exception {
  return {
    type: objCException.name,
    value: objCException.message,
    stacktrace: {
      frames: objCException.stackReturnAddresses.map( returnAddress => ({
        platform: 'cocoa',
        instruction_addr: returnAddress.toString(16).padStart(16, '0'),
      })),
    },
  };
}

// TODO: Needs to be exported from @sentry/browser
/**
 * This function creates an exception from a JavaScript Error
 */
export function exceptionFromError(stackParser: StackParser, ex: Error): Exception {
  // Get the frames first since Opera can lose the stack if we touch anything else first
  const frames = parseStackFrames(stackParser, ex);

  const exception: Exception = {
    type: ex && ex.name,
    value: extractMessage(ex),
  };

  if (frames.length) {
    exception.stacktrace = { frames };
  }

  if (exception.type === undefined && exception.value === '') {
    exception.value = 'Unrecoverable error caught';
  }

  return exception;
}

/** Parses stack frames from an error */
export function parseStackFrames(
  stackParser: StackParser,
  ex: Error & { framesToPop?: number; stacktrace?: string },
): StackFrame[] {
  // Access and store the stacktrace property before doing ANYTHING
  // else to it because Opera is not very good at providing it
  // reliably in other circumstances.
  const stacktrace = ex.stacktrace || ex.stack || '';

  const popSize = getPopSize(ex);

  try {
    return stackParser(stacktrace, popSize);
  } catch (e) {
    // no-empty
  }

  return [];
}

/**
 * There are cases where stacktrace.message is an Event object
 * https://github.com/getsentry/sentry-javascript/issues/1949
 * In this specific case we try to extract stacktrace.message.error.message
 */
function extractMessage(ex: Error & { message: { error?: Error } }): string {
  const message = ex && ex.message;
  if (!message) {
    return 'No error message';
  }
  if (message.error && typeof message.error.message === 'string') {
    return message.error.message;
  }
  return message;
}

// Based on our own mapping pattern - https://github.com/getsentry/sentry/blob/9f08305e09866c8bd6d0c24f5b0aabdd7dd6c59c/src/sentry/lang/javascript/errormapping.py#L83-L108
const reactMinifiedRegexp = /Minified React error #\d+;/i;

function getPopSize(ex: Error & { framesToPop?: number }): number {
  if (ex) {
    if (typeof ex.framesToPop === 'number') {
      return ex.framesToPop;
    }

    if (reactMinifiedRegexp.test(ex.message)) {
      return 1;
    }
  }

  return 0;
}
