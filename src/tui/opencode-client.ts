import { spawn, type ChildProcess } from 'child_process';
import * as http from 'http';
import { SseParser } from './opencode-sse.js';

export type OpencodeServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface ModalDialogsApi {
  selectList(options: {
    title: string;
    message: string;
    items: string[];
    defaultIndex?: number;
    cancelIndex?: number;
  }): Promise<number | null>;
  editTextarea(options: {
    title: string;
    initial: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }): Promise<string | null>;
  confirmTextbox(options: {
    title: string;
    message: string;
    confirmText: string;
    cancelLabel?: string;
  }): Promise<boolean>;
}

export interface PersistedStateStore {
  load(prefix?: string): Promise<any>;
  save(prefix: string | undefined, state: any): Promise<void>;
  getPrefix?: () => string | undefined;
}

export interface OpencodeSseHandlers {
  onTextDelta: (text: string) => void;
  onTextReset: (text: string) => void;
  onToolUse: (toolName: string, description?: string | null) => void;
  onToolResult: (content: string) => void;
  onPermissionRequest: () => void;
  onQuestionAsked: (question: { question: string; options?: Array<{ label?: string; value?: string }> }, raw: any) => void;
  onInputRequest: (input: { type?: string; prompt?: string }) => void;
  onSessionEnd: () => void;
}

export interface OpencodePaneApi {
  setLabel?: (label: string) => void;
  setContent?: (content: string) => void;
  getContent?: () => string;
  setScrollPerc?: (value: number) => void;
  pushLine?: (line: string) => void;
  focus?: () => void;
}

export interface OpencodeIndicatorApi {
  setContent?: (content: string) => void;
  show?: () => void;
  hide?: () => void;
}

export interface OpencodeInputFieldApi {
  setLabel?: (label: string) => void;
  show?: () => void;
  hide?: () => void;
  focus?: () => void;
  clearValue?: () => void;
  once?: (event: string, handler: (value: string) => void) => void;
}

export interface SendPromptOptions {
  prompt: string;
  pane: OpencodePaneApi;
  indicator?: OpencodeIndicatorApi | null;
  inputField?: OpencodeInputFieldApi | null;
  getSelectedItemId?: () => string | null;
  onComplete?: () => void;
}

export interface OpencodeClientOptions {
  port: number;
  log: (message: string) => void;
  showToast: (message: string) => void;
  modalDialogs: ModalDialogsApi;
  render: () => void;
  persistedState: PersistedStateStore;
  onStatusChange?: (status: OpencodeServerStatus, port: number) => void;
  httpImpl?: typeof http;
  spawnImpl?: typeof spawn;
}

export interface SessionSelectionResult {
  id: string;
  workItemId?: string | null;
  existing?: boolean;
  localHistory?: any[] | null;
}

export class OpencodeClient {
  private opencodeServerProc: ChildProcess | null = null;
  private opencodeServerStatus: OpencodeServerStatus = 'stopped';
  private opencodeServerPort = 0;
  private currentSessionId: string | null = null;
  private currentSessionWorkItemId: string | null = null;
  private readonly httpImpl: typeof http;
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: OpencodeClientOptions) {
    this.httpImpl = options.httpImpl || http;
    this.spawnImpl = options.spawnImpl || spawn;
    this.opencodeServerPort = 0;
  }

  getStatus(): { status: OpencodeServerStatus; port: number } {
    return { status: this.opencodeServerStatus, port: this.opencodeServerPort };
  }

  async startServer(): Promise<boolean> {
    const isRunning = await this.checkOpencodeServer(this.options.port);
    if (isRunning) {
      this.setStatus('running', this.options.port);
      return true;
    }

    this.setStatus('starting', this.options.port);
    this.options.showToast('Starting OpenCode server...');

    try {
      this.options.log(`starting opencode server port=${this.options.port}`);
      this.opencodeServerProc = this.spawnImpl('opencode', ['serve', '--port', String(this.options.port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      // Attach listeners but avoid re-attaching if they already exist (in
      // case startServer is retried). Use named functions so we can remove
      // them reliably in stopServer.
      const handleStdout = (chunk: any) => { this.options.log(`server stdout: ${chunk.toString().trim()}`); };
      const handleStderr = (chunk: any) => { this.options.log(`server stderr: ${chunk.toString().trim()}`); };
      const handleExit = (code: any, signal: any) => { this.options.log(`server exit code=${code ?? 'null'} signal=${signal ?? 'null'}`); };

      if (this.opencodeServerProc.stdout && !(this.opencodeServerProc.stdout as any).__opencode_listeners_installed) {
        this.opencodeServerProc.stdout.on('data', handleStdout);
        (this.opencodeServerProc.stdout as any).__opencode_listeners_installed = true;
      }
      if (this.opencodeServerProc.stderr && !(this.opencodeServerProc.stderr as any).__opencode_listeners_installed) {
        this.opencodeServerProc.stderr.on('data', handleStderr);
        (this.opencodeServerProc.stderr as any).__opencode_listeners_installed = true;
      }
      if (!(this.opencodeServerProc as any).__opencode_exit_listener_installed) {
        this.opencodeServerProc.on('exit', handleExit);
        (this.opencodeServerProc as any).__opencode_exit_listener_installed = true;
      }

      this.opencodeServerPort = this.options.port;

      let retries = 10;
      while (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const isUp = await this.checkOpencodeServer(this.options.port);
        if (isUp) {
          this.setStatus('running', this.options.port);
          this.options.showToast('OpenCode server started');
          return true;
        }
        retries--;
      }

      this.setStatus('error', this.options.port);
      this.options.showToast('OpenCode server failed to start');
      if (this.opencodeServerProc) {
        // Ensure we remove any listeners before killing the child process so
        // we don't leak handlers if the start attempt fails and we later
        // spawn again.
        try { this.opencodeServerProc.stdout?.removeAllListeners?.(); } catch (_) {}
        try { this.opencodeServerProc.stderr?.removeAllListeners?.(); } catch (_) {}
        try { this.opencodeServerProc.removeAllListeners?.(); } catch (_) {}
        this.opencodeServerProc.kill();
        this.opencodeServerProc = null;
      }
      return false;
    } catch (err) {
      this.setStatus('error', this.options.port);
      this.options.showToast(`Failed to start OpenCode server: ${String(err)}`);
      return false;
    }
  }

  stopServer(): void {
    if (!this.opencodeServerProc) return;
    try {
      // Remove listeners on stdout/stderr and the process itself to avoid
      // keeping references that may prevent GC or leak handlers across
      // restarts.
      try {
        if (this.opencodeServerProc.stdout) {
          try { this.opencodeServerProc.stdout.removeAllListeners(); } catch (_) {}
          try { delete (this.opencodeServerProc.stdout as any).__opencode_listeners_installed; } catch (_) {}
        }
      } catch (_) {}
      try {
        if (this.opencodeServerProc.stderr) {
          try { this.opencodeServerProc.stderr.removeAllListeners(); } catch (_) {}
          try { delete (this.opencodeServerProc.stderr as any).__opencode_listeners_installed; } catch (_) {}
        }
      } catch (_) {}
      try {
        try { this.opencodeServerProc.removeAllListeners(); } catch (_) {}
        try { delete (this.opencodeServerProc as any).__opencode_exit_listener_installed; } catch (_) {}
      } catch (_) {}

      this.opencodeServerProc.kill();
      this.opencodeServerProc = null;
      this.setStatus('stopped', this.opencodeServerPort);
    } catch (_) {
      // ignore
    }
  }

  async sendPrompt(options: SendPromptOptions): Promise<void> {
    const { prompt, pane, indicator, inputField, onComplete } = options;
    this.options.log(`send prompt length=${prompt.length}`);

    const safePushLine = (line: string) => {
      if (typeof pane.pushLine === 'function') {
        pane.pushLine(line);
        return;
      }
      if (typeof pane.setContent === 'function') {
        const current = pane.getContent ? pane.getContent() : '';
        const next = current ? `${current}\n${line}` : line;
        pane.setContent(next);
      }
    };

    return new Promise((resolve, reject) => {
      const preferredSessionId = options.getSelectedItemId ? options.getSelectedItemId() : null;
      const sessionPromise = this.resolveSessionSelection(preferredSessionId);

      sessionPromise
        .then(async (sessionObj: SessionSelectionResult) => {
          const sessionId = sessionObj.id;
          const sessionWorkItemId = sessionObj.workItemId || null;
          const sessionExisting = !!sessionObj.existing;
          this.currentSessionId = sessionId;
          this.currentSessionWorkItemId = sessionWorkItemId;

          if (pane.setLabel) {
            if (this.currentSessionWorkItemId) {
              pane.setLabel(` opencode - Work Item: ${this.currentSessionWorkItemId} [esc] `);
            } else {
              pane.setLabel(` opencode - Session: ${sessionId} [esc] `);
            }
          }

          if (sessionExisting) {
            try {
              const history = await this.getSessionMessages(sessionId);
              if (pane.setContent) {
                let histText = '';
                for (const m of history) {
                  const role = m.info?.role || 'unknown';
                  histText += `{gray-fg}[${role}]{/}\n`;
                  const parts = m.parts || [];
                  for (const p of parts) {
                    if (p.type === 'text' && p.text) {
                      histText += `${p.text}\n`;
                    } else if (p.type === 'tool-result' && p.content) {
                      histText += `{green-fg}[Tool Result]{/}\n`;
                      histText += `${p.content}\n`;
                    } else if (p.type === 'tool-use' && p.tool) {
                      histText += `{yellow-fg}[Tool: ${p.tool.name}]{/}\n`;
                      if (p.tool.description) histText += `${p.tool.description}\n`;
                    }
                  }
                  histText += '\n';
                }
                pane.setContent(histText + '\n');
              }
            } catch (err) {
              this.options.log(`failed to load session history: ${String(err)}`);
            }
          } else {
            try {
              const localHist = sessionObj.localHistory;
              if (localHist && Array.isArray(localHist) && localHist.length > 0) {
                this.options.log(`rendering local persisted history messages=${localHist.length} for workitem=${String(sessionWorkItemId)}`);
                if (pane.setContent) {
                  let histText = '{yellow-fg}[Local persisted history - read-only]{/}\n\n';
                  for (const m of localHist) {
                    const role = m.info?.role || 'unknown';
                    histText += `{gray-fg}[${role}]{/}\n`;
                    const parts = m.parts || [];
                    for (const p of parts) {
                      if (p.type === 'text' && p.text) {
                        histText += `${p.text}\n`;
                      } else if (p.type === 'tool-result' && p.content) {
                        histText += `{green-fg}[Tool Result]{/}\n`;
                        histText += `${p.content}\n`;
                      } else if (p.type === 'tool-use' && p.tool) {
                        histText += `{yellow-fg}[Tool: ${p.tool.name}]{/}\n`;
                        if (p.tool.description) histText += `${p.tool.description}\n`;
                      }
                    }
                    histText += '\n';
                  }
                  histText += '{yellow-fg}[End of local history]{/}\n\n';
                  pane.setContent(histText + '\n');
                }
              }
            } catch (err) {
              this.options.log(`failed to render local history: ${String(err)}`);
            }
          }

          let finalPrompt = prompt;
          if (!sessionExisting) {
            try {
              const localHist = sessionObj.localHistory;
              if (localHist && Array.isArray(localHist) && localHist.length > 0) {
                const choice = await this.options.modalDialogs.selectList({
                  title: 'Restore session',
                  message: 'Local persisted conversation found. How would you like to proceed?',
                  items: ['Show only (no restore)', 'Restore via summary (recommended)', 'Full replay (danger)', 'Cancel'],
                  defaultIndex: 0,
                  cancelIndex: 3,
                });

                if (choice === 1) {
                  const generated = this.generateSummaryFromHistory(localHist);
                  const edited = await this.options.modalDialogs.editTextarea({
                    title: 'Edit summary (sent as context)',
                    initial: generated,
                    confirmLabel: 'Send summary',
                    cancelLabel: 'Cancel',
                  });
                  if (edited && edited.trim()) {
                    finalPrompt = `Context summary (user-edited):\n${edited}\n\nUser prompt:\n${prompt}`;
                  }
                } else if (choice === 2) {
                  const confirm = await this.options.modalDialogs.confirmTextbox({
                    title: 'Confirm full replay',
                    message: '{red-fg}Warning:{/red-fg} Full replay may re-run tool calls or side-effects. Type YES to confirm, or select Cancel.',
                    confirmText: 'YES',
                    cancelLabel: 'Cancel',
                  });
                  if (confirm) {
                    const allText: string[] = [];
                    for (const m of localHist) {
                      const parts = m.parts || [];
                      for (const p of parts) {
                        if (p.type === 'text' && p.text) allText.push(p.text);
                        else if (p.type === 'tool-result' && p.content) allText.push('[Tool Result]\n' + String(p.content));
                      }
                    }
                    const replayText = allText.join('\n\n---\n\n');
                    finalPrompt = `Full replay of previous conversation:\n${replayText}\n\nUser prompt:\n${prompt}`;
                  }
                }
              }
            } catch (err) {
              this.options.log(`restore flow error: ${String(err)}`);
            }
          }

          safePushLine('');
          safePushLine(`{gray-fg}${prompt}{/}`);
          safePushLine('');
          if (pane.setScrollPerc) {
            pane.setScrollPerc(100);
          }
          this.options.render();
          this.options.log(`session id=${sessionId} workitem=${String(this.currentSessionWorkItemId)}`);

          const messageData = JSON.stringify({
            parts: [{ type: 'text', text: finalPrompt }],
          });

          const sendOptions = {
            hostname: 'localhost',
            port: this.opencodeServerPort,
            path: `/session/${sessionId}/prompt_async`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(messageData),
            },
          };

          const sendReq = this.httpImpl.request(sendOptions, (res) => {
            this.options.log(`prompt_async status=${res.statusCode ?? 'unknown'}`);
            if (res.statusCode === 204) {
              this.connectToSSE(sessionId, finalPrompt, pane, indicator, inputField, resolve, reject, onComplete);
            } else {
              let errorData = '';
              res.on('data', chunk => { errorData += chunk; });
              res.on('end', () => {
                this.options.log(`prompt_async error response status=${res.statusCode} length=${errorData.length}`);
                const errorMsg = errorData || `HTTP ${res.statusCode} error`;
                safePushLine(`{red-fg}Error sending prompt: ${errorMsg}{/}`);
                this.options.render();
                reject(new Error(`Failed to send prompt: ${errorMsg}`));
              });
            }
          });

          sendReq.on('error', (err) => {
            this.options.log(`prompt_async request error: ${String(err)}`);
            safePushLine(`{red-fg}Request error: ${err}{/}`);
            this.options.render();
            reject(err);
          });

          sendReq.write(messageData);
          sendReq.end();
        })
        .catch((err: unknown) => {
          safePushLine(`{red-fg}Session error: ${err}{/}`);
          this.options.render();
          reject(err);
        });
    });
  }

  private setStatus(status: OpencodeServerStatus, port: number): void {
    this.opencodeServerStatus = status;
    this.opencodeServerPort = port;
    if (this.options.onStatusChange) {
      this.options.onStatusChange(status, port);
    }
  }

  private resolveSessionSelection(preferredSessionId: string | null): Promise<SessionSelectionResult> {
    const sessionFromMemory = this.getSessionFromCurrent(preferredSessionId);
    if (sessionFromMemory) return Promise.resolve(sessionFromMemory);
    return this.createSession(preferredSessionId);
  }

  private getSessionFromCurrent(preferredSessionId: string | null): SessionSelectionResult | null {
    if (this.currentSessionId && preferredSessionId && this.currentSessionId === preferredSessionId) {
      return { id: this.currentSessionId, workItemId: preferredSessionId, existing: true };
    }
    return null;
  }

  private async checkOpencodeServer(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = this.httpImpl.request({
        hostname: '127.0.0.1',
        port,
        path: '/global/health',
        method: 'GET',
        timeout: 1000,
      }, (res) => {
        const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
        res.resume();
        this.options.log(`health status=${res.statusCode ?? 'unknown'} ok=${ok}`);
        resolve(ok);
      });

      req.on('timeout', () => {
        req.destroy();
        this.options.log('health check timed out');
        resolve(false);
      });

      req.on('error', () => {
        this.options.log('health check error');
        resolve(false);
      });

      req.end();
    });
  }

  private connectToSSE(
    sessionId: string,
    prompt: string,
    pane: OpencodePaneApi,
    indicator: OpencodeIndicatorApi | null | undefined,
    inputField: OpencodeInputFieldApi | null | undefined,
    resolve: Function,
    reject: Function,
    onComplete?: () => void,
  ) {
    let resRef: any = null;
    let req: any = null;
    const onSessionEnd = () => {
      try { req?.abort?.(); } catch (_) {}
      try { resRef?.removeAllListeners?.(); } catch (_) {}
      try { req?.removeAllListeners?.(); } catch (_) {}
      if (onComplete) onComplete();
      resolve();
    };
    const sessionTools = this.createSessionTools(sessionId, pane, indicator, inputField, onSessionEnd);
    const partTextById = new Map<string, string>();
    const messageRoleById = new Map<string, string>();
    let lastUserMessageId: string | null = null;
    let sseClosed = false;
    let waitingForInput = false;
    const { appendLine, updatePane } = sessionTools;
    const options = {
      hostname: 'localhost',
      port: this.opencodeServerPort,
      path: '/event',
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    };
    this.options.log(`sse connect session=${sessionId}`);

    const parser = new SseParser();
    const handlePayload = (payload: string) => {
      if (sseClosed) return;
      if (!payload) return;
      if (payload === '[DONE]') {
        this.options.log('sse done received');
        sseClosed = true;
        onSessionEnd();
        return;
      }

      try {
        const payloadPreview = payload.length > 200 ? `${payload.slice(0, 200)}...` : payload;
        this.options.log(`sse payload length=${payload.length} preview=${payloadPreview}`);
        const data = JSON.parse(payload);
        const dataType = data?.type || 'unknown';
        this.options.log(`sse data type=${dataType}`);

        this.handleSseEvent({
          data,
          sessionId,
          partTextById,
          messageRoleById,
          lastUserMessageId,
          prompt,
          handlers: sessionTools.handlers,
          setLastUserMessageId: (value) => { lastUserMessageId = value; },
          waitingForInput,
          setWaitingForInput: (value) => { waitingForInput = value; },
        });
      } catch (err) {
        this.options.log(`sse parse error: ${String(err)}`);
      }
    };

    req = this.httpImpl.request(options, (res) => {
      resRef = res;
      this.options.log(`sse status=${res.statusCode ?? 'unknown'}`);

      res.on('data', (chunk: Buffer) => {
        this.options.log(`sse chunk bytes=${chunk.length}`);
        const events = parser.push(chunk);
        for (const event of events) {
          handlePayload(event.data);
        }
      });

      res.on('end', () => {
        const pending = parser.flush();
        for (const event of pending) {
          handlePayload(event.data);
        }
        if (sseClosed) {
          this.options.log('sse ended after close');
          resolve();
          return;
        }
        appendLine('{yellow-fg}Stream ended{/}');
        updatePane();
        this.options.log('sse ended');
        resolve();
      });

      res.on('error', (err: unknown) => {
        const errMessage = String(err);
        const errCode = (err as any)?.code;
        if (sseClosed || errMessage.includes('aborted') || errCode === 'ECONNRESET') {
          this.options.log(`sse response closed: ${errMessage}`);
          resolve();
          return;
        }
        this.options.log(`sse response error: ${errMessage}`);
        appendLine(`{red-fg}SSE error: ${err}{/}`);
        updatePane();
        // ensure listeners are removed to avoid leaking across retries
        try { resRef?.removeAllListeners?.(); } catch (_) {}
        try { req.removeAllListeners?.(); } catch (_) {}
        reject(err);
      });
    });

    req.on('error', (err: unknown) => {
      const errMessage = String(err);
      const errCode = (err as any)?.code;
      if (sseClosed || errMessage.includes('aborted') || errCode === 'ECONNRESET') {
        this.options.log(`sse connection closed: ${errMessage}`);
        resolve();
        return;
      }
      this.options.log(`sse connection error: ${errMessage}`);
      if (pane.pushLine) {
        pane.pushLine(`{red-fg}Connection error: ${errMessage}{/}`);
      }
      this.options.render();
      try { resRef?.removeAllListeners?.(); } catch (_) {}
      try { req.removeAllListeners?.(); } catch (_) {}
      reject(err);
    });

    req.end();
  }

  private sendInputResponse(sessionId: string, input: string) {
    const responseData = JSON.stringify({ input });
    this.options.log(`send input response length=${input.length}`);

    const options = {
      hostname: 'localhost',
      port: this.opencodeServerPort,
      path: `/session/${sessionId}/input`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(responseData),
      },
    };

    const req = this.httpImpl.request(options, (res) => {
      this.options.log(`input response status=${res.statusCode ?? 'unknown'}`);
    });

    req.on('error', (err: unknown) => {
      this.options.log(`input response error: ${String(err)}`);
      console.error('Failed to send input response:', err);
    });

    req.write(responseData);
    req.end();
  }

  private getSessionId(value: any): string | undefined {
    return value?.sessionID || value?.sessionId || value?.session_id;
  }

  private createSessionTools(
    sessionId: string,
    pane: OpencodePaneApi,
    indicator: OpencodeIndicatorApi | null | undefined,
    inputField: OpencodeInputFieldApi | null | undefined,
    onSessionEnd: () => void,
  ) {
    let streamText = pane.getContent ? pane.getContent() : '';
    const appendText = (text: string) => {
      streamText += text;
    };
    const appendLine = (line: string) => {
      if (streamText && !streamText.endsWith('\n')) {
        streamText += '\n';
      }
      streamText += line;
    };
    const updatePane = () => {
      if (pane.setContent) {
        pane.setContent(streamText);
      }
      if (typeof pane.setScrollPerc === 'function') {
        pane.setScrollPerc(100);
      }
      this.options.render();
    };
    const handlers: OpencodeSseHandlers = {
      onTextDelta: (text) => {
        appendText(text);
        updatePane();
      },
      onTextReset: (text) => {
        appendLine(text);
        updatePane();
      },
      onToolUse: (toolName, description) => {
        appendLine(`{yellow-fg}[Tool: ${toolName}]{/}`);
        if (description) {
          appendLine(`  ${description}`);
        }
        updatePane();
      },
      onToolResult: (content) => {
        appendLine('{green-fg}[Tool Result]{/}');
        const resultLines = content.split('\n');
        for (const line of resultLines.slice(0, 10)) {
          appendLine(`  ${line}`);
        }
        if (resultLines.length > 10) {
          appendLine(`  ... (${resultLines.length - 10} more lines)`);
        }
        updatePane();
      },
      onPermissionRequest: () => {
        indicator?.setContent?.('{yellow-fg}[!] Permission Required{/}');
        indicator?.show?.();
        inputField?.setLabel?.(' Permission Request ');
        inputField?.show?.();
        inputField?.focus?.();
        updatePane();
      },
      onQuestionAsked: (question, raw) => {
        this.options.log(`sse question asked: ${question.question}`);
        this.options.log(`sse question options: ${JSON.stringify(question.options || [])}`);

        appendLine(`{yellow-fg}OpenCode asking: ${question.question}{/}`);

        let answer = 'save';
        if (question.options && question.options.length > 0) {
          answer = question.options[0].label || question.options[0].value || 'save';
          appendLine(`{green-fg}Auto-answering with: ${answer}{/}`);
          this.options.log(`sse question answering with: ${answer} from options: ${JSON.stringify(question.options[0])}`);
        } else {
          this.options.log(`sse question no options, using default: ${answer}`);
        }

        const answerData = JSON.stringify({
          questionID: raw?.properties?.id,
          answer,
        });

        this.options.log(`sse question sending answer: ${answerData}`);

        const answerOptions = {
          hostname: 'localhost',
          port: this.opencodeServerPort,
          path: `/session/${sessionId}/answer`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(answerData),
          },
        };

        const answerReq = this.httpImpl.request(answerOptions, (res) => {
          this.options.log(`question answer status=${res.statusCode ?? 'unknown'}`);
        });

        answerReq.on('error', (err: unknown) => {
          this.options.log(`question answer error: ${String(err)}`);
          appendLine(`{red-fg}Failed to answer question: ${String(err)}{/}`);
        });

        answerReq.write(answerData);
        answerReq.end();
      },
      onInputRequest: (input) => {
        const inputType = input.type || 'text';
        const promptText = input.prompt || 'Input required';

        appendLine(`{yellow-fg}${promptText}{/}`);
        indicator?.setContent?.('{yellow-fg}[!] Input Required{/}');
        indicator?.show?.();

        if (inputType === 'boolean') {
          inputField?.setLabel?.(' Yes/No Input ');
        } else if (inputType === 'password') {
          inputField?.setLabel?.(' Password Input ');
        } else {
          inputField?.setLabel?.(' Input Required ');
        }

        inputField?.show?.();
        inputField?.focus?.();
        updatePane();
        this.options.log(`sse input request type=${inputType}`);

        inputField?.once?.('submit', (value: string) => {
          this.sendInputResponse(sessionId, value);

          indicator?.hide?.();
          inputField?.hide?.();
          inputField?.clearValue?.();
          pane.focus?.();

          appendLine(`{cyan-fg}> ${value}{/}`);
          updatePane();
        });
      },
      onSessionEnd,
    };

    return { appendText, appendLine, updatePane, handlers };
  }

  private handleSseEvent(params: {
    data: any;
    sessionId: string;
    partTextById: Map<string, string>;
    messageRoleById: Map<string, string>;
    lastUserMessageId: string | null;
    prompt: string;
    handlers: OpencodeSseHandlers;
    setLastUserMessageId: (value: string) => void;
    waitingForInput: boolean;
    setWaitingForInput: (value: boolean) => void;
  }) {
    const {
      data,
      sessionId,
      partTextById,
      messageRoleById,
      lastUserMessageId,
      prompt,
      handlers,
      setLastUserMessageId,
      waitingForInput,
      setWaitingForInput,
    } = params;
    const dataType = data?.type || 'unknown';

    const isMessagePart = dataType === 'message.part' || dataType === 'message.part.updated' || dataType === 'message.part.created';
    if (isMessagePart && data.properties) {
      const part = data.properties.part;
      const partSessionId = this.getSessionId(part);
      const eventSessionId = partSessionId || this.getSessionId(data.properties) || this.getSessionId(data);
      if (part && eventSessionId === sessionId) {
        const role = messageRoleById.get(part.messageID);
        const isUserMessage = role === 'user' || (lastUserMessageId !== null && part.messageID === lastUserMessageId);
        const promptMatches = prompt && part.text && part.text.trim() === prompt.trim();
        if (isUserMessage || promptMatches) {
          this.options.log(`sse message.part skipped user prompt role=${role ?? 'unknown'} messageID=${part.messageID}`);
          partTextById.set(part.id || 'unknown', part.text || '');
          return;
        }
        if (part.type === 'text' && part.text) {
          const partId = part.id || 'unknown';
          const prevText = partTextById.get(partId) || '';
          if (part.text.startsWith(prevText)) {
            const diff = part.text.slice(prevText.length);
            if (diff) {
              handlers.onTextDelta(diff);
            }
            this.options.log(`sse text diff chars=${diff.length}`);
          } else if (!prevText.startsWith(part.text)) {
            handlers.onTextReset(part.text);
            this.options.log(`sse text reset chars=${part.text.length}`);
          } else {
            this.options.log(`sse text unchanged chars=${part.text.length}`);
          }
          partTextById.set(partId, part.text);
        } else if (part.type === 'tool-use' && part.tool) {
          handlers.onToolUse(part.tool.name, part.tool.description);
          this.options.log(`sse tool use=${part.tool.name}`);
        } else if (part.type === 'tool-result' && part.content) {
          handlers.onToolResult(part.content);
          this.options.log(`sse tool result lines=${String(part.content).split('\n').length}`);
        } else if (part.type === 'permission-request') {
          setWaitingForInput(true);
          handlers.onPermissionRequest();
          this.options.log('sse permission request');
        }
      } else {
        this.options.log(`sse message.part ignored session=${eventSessionId ?? 'unknown'}`);
      }
      return;
    }

    if (dataType === 'message.updated' && data.properties?.info) {
      const info = data.properties.info;
      const messageId = info.id;
      const messageRole = info.role;
      if (messageId && messageRole) {
        messageRoleById.set(messageId, messageRole);
        if (messageRole === 'user') {
          setLastUserMessageId(messageId);
        }
        this.options.log(`sse message updated role=${messageRole} id=${messageId}`);
      }
      return;
    }

    if (dataType === 'message.finish' && data.properties) {
      const finishSessionId = this.getSessionId(data.properties) || this.getSessionId(data);
      if (finishSessionId === sessionId) {
        this.options.log('sse message finish');
        handlers.onSessionEnd();
      }
      return;
    }

    if (dataType === 'session.status' && data.properties) {
      const statusSessionId = this.getSessionId(data.properties) || this.getSessionId(data);
      const statusType = data.properties.status?.type;
      if (statusSessionId === sessionId && statusType === 'idle') {
        this.options.log('sse session idle');
        handlers.onSessionEnd();
      }
      return;
    }

    if (dataType === 'question.asked' && data.properties) {
      const questionSessionId = this.getSessionId(data.properties) || this.getSessionId(data);
      if (questionSessionId === sessionId) {
        const questions = data.properties.questions;
        if (questions && questions.length > 0) {
          handlers.onQuestionAsked(questions[0], data);
        }
      }
      return;
    }

    if (dataType === 'input.request' && data.properties) {
      const inputSessionId = this.getSessionId(data.properties) || this.getSessionId(data);
      if (inputSessionId === sessionId) {
        if (!waitingForInput) {
          setWaitingForInput(true);
        }
        handlers.onInputRequest({ type: data.properties.type, prompt: data.properties.prompt });
      }
    }
  }

  private async getPersistedSessionIdForWorkItem(workItemId: string): Promise<string | null> {
    try {
      const persisted = await this.options.persistedState.load(this.options.persistedState.getPrefix?.() || undefined) || {};
      return persisted.sessionMap && persisted.sessionMap[workItemId] ? persisted.sessionMap[workItemId] : null;
    } catch (_) {
      return null;
    }
  }

  private async persistSessionMapping(workItemId: string, sessionId: string): Promise<void> {
    try {
      const prefix = this.options.persistedState.getPrefix?.();
      const state = await this.options.persistedState.load(prefix) || {};
      state.sessionMap = state.sessionMap || {};
      state.sessionMap[workItemId] = sessionId;
      await this.options.persistedState.save(prefix, state);
      this.options.log(`persistSessionMapping workitem=${workItemId} -> session=${sessionId}`);
    } catch (err) {
      this.options.log(`failed to persist session mapping: ${String(err)}`);
    }
  }

  private async persistSessionHistory(workItemId: string, history: any[]): Promise<void> {
    try {
      const prefix = this.options.persistedState.getPrefix?.();
      const state = await this.options.persistedState.load(prefix) || {};
      state.sessionHistories = state.sessionHistories || {};
      state.sessionHistories[workItemId] = history;
      await this.options.persistedState.save(prefix, state);
      this.options.log(`persistSessionHistory workitem=${workItemId} messages=${(history || []).length}`);
    } catch (err) {
      this.options.log(`failed to persist session history: ${String(err)}`);
    }
  }

  private async loadPersistedSessionHistory(workItemId: string): Promise<any[] | null> {
    try {
      const persisted = await this.options.persistedState.load(this.options.persistedState.getPrefix?.() || undefined) || {};
      return persisted.sessionHistories && persisted.sessionHistories[workItemId] ? persisted.sessionHistories[workItemId] : null;
    } catch (_) {
      return null;
    }
  }

  private generateSummaryFromHistory(history: any[]): string {
    try {
      if (!history || history.length === 0) return '';
      const pieces: string[] = [];
      for (let i = history.length - 1; i >= 0 && pieces.length < 8; i--) {
        const m = history[i];
        const parts = m.parts || [];
        for (let j = parts.length - 1; j >= 0; j--) {
          const p = parts[j];
          if (p.type === 'text' && p.text) {
            const t = String(p.text).trim();
            if (t) pieces.push(t);
          } else if (p.type === 'tool-result' && p.content) {
            const t = String(p.content).split('\n').slice(0, 4).join(' ').trim();
            if (t) pieces.push(`[Tool result] ${t}`);
          }
          if (pieces.length >= 8) break;
        }
      }
      pieces.reverse();
      let joined = pieces.join('\n\n');
      if (joined.length > 1200) joined = joined.slice(0, 1200) + '...';
      return joined;
    } catch (err) {
      this.options.log(`summary error: ${String(err)}`);
      return '';
    }
  }

  private getSessionMessages(sessionId: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: 'localhost',
        port: this.opencodeServerPort,
        path: `/session/${encodeURIComponent(sessionId)}/message`,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      };
      const r = this.httpImpl.request(opts, (resp) => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          if (!body) return resolve([]);
          try {
            const parsed = JSON.parse(body);
            if (Array.isArray(parsed)) return resolve(parsed);
            return resolve([]);
          } catch (err) {
            return reject(err);
          }
        });
      });
      r.on('error', (err) => reject(err));
      r.end();
    });
  }

  private checkSessionExists(sessionId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const opts = {
        hostname: 'localhost',
        port: this.opencodeServerPort,
        path: `/session/${encodeURIComponent(sessionId)}`,
        method: 'GET',
        timeout: 2000,
        headers: { 'Accept': 'application/json' },
      } as any;
      const r = this.httpImpl.request(opts, (resp) => {
        const ok = resp.statusCode !== undefined && resp.statusCode >= 200 && resp.statusCode < 300;
        resp.resume();
        resolve(ok);
      });
      r.on('error', () => resolve(false));
      r.on('timeout', () => { r.destroy(); resolve(false); });
      r.end();
    });
  }

  private findSessionByTitle(preferredId: string): Promise<string | null> {
    return new Promise((resolve) => {
      const searchTitle = `workitem:${preferredId}`;
      const opts = {
        hostname: 'localhost',
        port: this.opencodeServerPort,
        path: '/session',
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      };
      const r = this.httpImpl.request(opts, (resp) => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          if (!body) return resolve(null);
          try {
            const parsed = JSON.parse(body);
            if (!Array.isArray(parsed)) return resolve(null);
            for (const s of parsed) {
              const title = s?.title || s?.name || '';
              if (typeof title === 'string' && title.includes(searchTitle)) {
                return resolve(s.id || s.sessionId || s.session_id || null);
              }
            }
            return resolve(null);
          } catch (_) {
            return resolve(null);
          }
        });
      });
      r.on('error', () => resolve(null));
      r.end();
    });
  }

  private async createSession(preferredId?: string | null): Promise<SessionSelectionResult> {
    const sessionPayload: any = { title: 'TUI Session ' + new Date().toISOString() };
    if (preferredId) sessionPayload.title = `workitem:${preferredId} ${sessionPayload.title}`;
    if (preferredId) sessionPayload.id = preferredId;
    const sessionData = JSON.stringify(sessionPayload);
    this.options.log('create session');

    return this.resolveSession(preferredId, sessionData);
  }

  private async resolveSession(
    preferredId: string | null | undefined,
    sessionData: string,
  ): Promise<SessionSelectionResult> {

    try {
      if (preferredId) {
        const persistedId = await this.getPersistedSessionIdForWorkItem(preferredId);
        if (persistedId) {
          const exists = await this.checkSessionExists(persistedId);
          if (exists) {
            this.options.log(`reusing persisted session mapping for workitem=${preferredId} id=${persistedId}`);
            return { id: persistedId, workItemId: preferredId, existing: true };
          }
          const persistedHistory = await this.loadPersistedSessionHistory(preferredId);
          if (persistedHistory) {
            this.options.log(`found ${persistedHistory.length} persisted messages for workitem=${preferredId} (will NOT auto-replay)`);
          }
        }

        const existing = await this.findSessionByTitle(preferredId);
        if (existing) {
          this.options.log(`found existing session for workitem=${preferredId} id=${existing}`);
          void this.persistSessionMapping(preferredId, existing);
          return { id: existing, workItemId: preferredId, existing: true };
        }
      }
    } catch (err) {
      this.options.log(`session lookup error: ${String(err)}`);
    }

    const options = {
      hostname: 'localhost',
      port: this.opencodeServerPort,
      path: '/session',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(sessionData),
      },
    } as any;

    const sessionResponse: any = await new Promise((resolve, reject) => {
      const req = this.httpImpl.request(options, (res) => {
        let responseData = '';
        this.options.log(`create session status=${res.statusCode ?? 'unknown'}`);

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.write(sessionData);
      req.end();
    });

    try {
      const session = sessionResponse;
      this.options.log(`create session response length=${JSON.stringify(session).length}`);
      const returnedId = session?.id || session?.sessionId || session?.session_id || preferredId;
      let returnedWorkItemId: string | null = null;
      const returnedTitle = session?.title || session?.name || '';
      if (typeof returnedTitle === 'string') {
        const m = returnedTitle.match(/workitem:([A-Za-z0-9_\-]+)/);
        if (m) returnedWorkItemId = m[1];
      }
      if (preferredId && returnedId) {
        void this.persistSessionMapping(preferredId, returnedId);
      }

      try {
        const fetched = returnedId ? await this.getSessionMessages(returnedId as string) : null;
        if (preferredId && fetched && fetched.length > 0) void this.persistSessionHistory(preferredId, fetched);
      } catch (_) {
        // ignore
      }

      const localHistory = preferredId ? await this.loadPersistedSessionHistory(preferredId) : null;

      return { id: returnedId as string, workItemId: returnedWorkItemId || preferredId || null, localHistory };
    } catch (err) {
      this.options.log(`create session parse error: ${String(err)}`);
      throw new Error('Failed to create session: ' + String(err));
    }
  }
}
