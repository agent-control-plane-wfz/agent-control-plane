// Minimal ndjson JSON-RPC 2.0 client over a child process stdio.
// Zero deps. Generalized from phase0/smoke-acp.mjs.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class JsonRpcStdio {
  private child;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private stderrTail: string[] = [];
  exited = false;
  exitCode: number | null = null;

  onNotification: ((method: string, params: any) => void) | null = null;
  onRequest: ((method: string, params: any) => Promise<any> | any) | null = null;

  readonly label: string;

  constructor(cmd: string, args: string[], cwd: string, label = 'jsonrpc') {
    this.label = label;
    this.child = spawn(cmd, args, { cwd, windowsHide: true });
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (d) => {
      this.stderrTail.push(d.toString().trim());
      if (this.stderrTail.length > 200) this.stderrTail.shift();
    });
    this.child.on('exit', (code) => {
      this.exited = true;
      this.exitCode = code;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${this.label}: process exited (code=${code}) with pending request`));
      }
      this.pending.clear();
    });
  }

  private handleLine(line: string) {
    const s = line.trim();
    if (!s || !s.startsWith('{')) return;
    let m: any;
    try { m = JSON.parse(s); } catch { return; }
    if (m.id === undefined || m.id === null) {
      if (m.method && this.onNotification) this.onNotification(m.method, m.params);
      return;
    }
    // Request from the agent side (e.g. permission requests) — answer with error unless handled.
    if (typeof m.method === 'string') {
      if (this.onRequest) {
        Promise.resolve(this.onRequest(m.method, m.params))
          .then((r) => this.write({ jsonrpc: '2.0', id: m.id, result: r ?? {} }))
          .catch((e) => this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e) } }));
      } else {
        this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      }
      return;
    }
    const p = this.pending.get(Number(m.id));
    if (p) {
      this.pending.delete(Number(m.id));
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(`${this.label}: ${m.error.message}${m.error.data ? ' ' + JSON.stringify(m.error.data).slice(0, 300) : ''}`));
      else p.resolve(m.result);
    }
  }

  private write(obj: unknown) {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    if (this.exited) return Promise.reject(new Error(`${this.label}: process already exited`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: timeout (${timeoutMs}ms) waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  stderr(): string {
    return this.stderrTail.join('\n').slice(-4000);
  }

  async close(): Promise<void> {
    try { this.child.kill(); } catch { /* noop */ }
    if (this.exited) return;
    await new Promise<void>((r) => {
      const t = setTimeout(r, 2000);
      this.child.on('exit', () => { clearTimeout(t); r(); });
    });
  }
}
