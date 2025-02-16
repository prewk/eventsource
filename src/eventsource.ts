import { EventSourceMessage, getLines, getMessages, readChunks } from './parse';

const ContentTypeEventStream = 'text/event-stream';

export type EventSourceOptions = {
  disableRetry?: boolean;
  retry?: number;
} & Omit<RequestInit, 'cache' | 'credentials' | 'signal'>;

export class CustomEventSource extends EventTarget implements EventSource {
  // https://html.spec.whatwg.org/multipage/server-sent-events.html#dom-eventsource-url
  public url: string;

  // https://html.spec.whatwg.org/multipage/server-sent-events.html#dom-eventsource-readystate
  public readonly CONNECTING = 0;
  public readonly OPEN = 1;
  public readonly CLOSED = 2;
  public readyState = this.CONNECTING;

  // https://html.spec.whatwg.org/multipage/server-sent-events.html#handler-eventsource-onopen
  public onerror: ((this: EventSource, ev: Event) => any) | null = null;
  // https://html.spec.whatwg.org/multipage/server-sent-events.html#handler-eventsource-onmessage
  public onmessage: ((this: EventSource, ev: MessageEvent) => any) | null =
    null;
  // https://html.spec.whatwg.org/multipage/server-sent-events.html#handler-eventsource-onerror
  public onopen: ((this: EventSource, ev: Event) => any) | null = null;

  public onRetryDelayReceived:
    | ((this: EventSource, delay: number) => any)
    | null = null;

  public readonly options: EventSourceInit & EventSourceOptions;
  private abortController?: AbortController;
  private retry: number;
  private currentLastEventId?: string;

  constructor(
    url: string | URL,
    initDict?: EventSourceInit & EventSourceOptions,
  ) {
    super();
    this.url = url instanceof URL ? url.toString() : url;
    this.options = initDict ?? {};
    this.retry = initDict?.retry ?? 5000;
    this.connect();
  }

  // https://html.spec.whatwg.org/multipage/server-sent-events.html#dom-eventsource-withcredentials
  public get withCredentials(): boolean {
    return this.options.withCredentials ?? false;
  }

  public get retryDelay(): number {
    return this.retry;
  }

  private async connect(lastEventId?: string) {
    try {
      // https://html.spec.whatwg.org/multipage/server-sent-events.html#dom-eventsource
      this.abortController = new AbortController();
      this.readyState = this.CONNECTING;

      const fetchOptions: RequestInit = {
        ...this.options,
        headers: lastEventId
          ? {
              ...this.options.headers,
              Accept: ContentTypeEventStream,
              'Last-Event-ID': lastEventId,
            }
          : {
              ...this.options.headers,
              Accept: ContentTypeEventStream,
            },
        cache: 'no-store',
        credentials: this.withCredentials ? 'include' : 'omit',
        signal: this.abortController?.signal,
      };

      const response = await globalThis.fetch(this.url, fetchOptions);

      // https://html.spec.whatwg.org/multipage/server-sent-events.html#dom-eventsource (Step 15)
      if (response.status !== 200) {
        return this.failConnection(
          `Request failed with status code ${response.status}`,
        );
      } else if (
        !response.headers.get('Content-Type')?.includes(ContentTypeEventStream)
      ) {
        return this.failConnection(
          `Request failed with wrong content type '${response.headers.get(
            'Content-Type',
          )}'`,
        );
      } else if (!response?.body) {
        return this.failConnection(`Request failed with empty response body'`);
      }

      this.announceConnection();

      const reader: ReadableStreamDefaultReader<Uint8Array> =
        response.body.getReader();
      const getLine = getLines();
      const getMessage = getMessages();

      for await (const chunk of readChunks(reader)) {
        for await (const [line, fieldLength] of getLine(chunk)) {
          for await (const [message, id, retry] of getMessage(
            line,
            fieldLength,
          )) {
            if (typeof id !== 'undefined') {
              this.currentLastEventId = id;
            } else if (typeof retry !== 'undefined') {
              this.retry = retry;
              this.onRetryDelayReceived?.(retry);
            } else if (message) {
              this.dispatchMessage(
                message,
                this.currentLastEventId,
                response.url,
              );
            }
          }
        }
      }
    } catch (error: any) {
      if (typeof error === 'object' && error?.name === 'AbortError') {
        return;
      }

      await this.reconnect('Reconnecting EventSource because of error', error);
      return;
    }

    await this.reconnect('Reconnecting because EventSource connection closed');
  }

  // https://html.spec.whatwg.org/multipage/server-sent-events.html#reestablish-the-connection
  private async reconnect(msg?: string, error?: unknown) {
    const event = new Event('error');
    this.dispatchEvent(event);
    this.onerror?.(event);

    if (error) {
      console.warn('Error occurred in EventSource', error ?? '');
    }

    if (this.readyState === this.CLOSED || this.options.disableRetry) {
      return;
    }

    if (msg) {
      console.warn(msg, error ?? '');
    }

    setTimeout(async () => {
      await this.connect(this.currentLastEventId);
    }, this.retry);
  }

  // https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage
  private dispatchMessage(
    message: EventSourceMessage,
    lastEventId?: string,
    url?: string,
  ) {
    const origin = url && URL.canParse(url) ? new URL(url) : undefined;
    const eventType = !message?.event ? 'message' : message.event;
    const event = new MessageEvent(eventType, {
      data: message?.data,
      // https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage (Note)
      lastEventId: message?.id || lastEventId,
      origin: origin?.origin,
    });

    this.dispatchEvent(event);
    if (eventType === 'message') {
      this.onmessage?.(event);
    }
  }

  // https://html.spec.whatwg.org/multipage/server-sent-events.html#fail-the-connection
  private failConnection(error: unknown) {
    console.error('Fatal error occurred in EventSource', error);
    this.readyState = this.CLOSED;
    const event = new Event('error');
    this.dispatchEvent(event);
    this.onerror?.(event);
  }

  // https://html.spec.whatwg.org/multipage/server-sent-events.html#announce-the-connection
  private announceConnection() {
    console.debug('Connection established');
    this.readyState = this.OPEN;
    const event = new Event('open');
    this.dispatchEvent(event);
    this.onopen?.(event);
  }

  // https://html.spec.whatwg.org/multipage/server-sent-events.html#dom-eventsource-close
  public close() {
    this.readyState = this.CLOSED;
    this.abortController?.abort();
  }

  override addEventListener(
    type: string,
    listener: (this: EventSource, event: MessageEvent) => any,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener<K extends keyof EventSourceEventMap>(
    type: K,
    listener: (this: EventSource, ev: EventSourceEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(
      type,
      listener as EventListenerOrEventListenerObject,
      options,
    );
  }

  override removeEventListener(
    type: string,
    listener: (this: EventSource, event: MessageEvent) => any,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener<K extends keyof EventSourceEventMap>(
    type: K,
    listener: (this: EventSource, ev: EventSourceEventMap[K]) => any,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(
      type,
      listener as EventListenerOrEventListenerObject,
      options,
    );
  }
}
