import { Buffer } from 'node:buffer';
import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outputsDir = path.join(rootDir, 'outputs');

const chromeCandidates = [
  process.env.CHROME_PATH,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
].filter((candidate): candidate is string => Boolean(candidate));

async function isExecutable(command: string): Promise<string | null> {
  if (command.includes(path.sep)) {
    try {
      await access(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const resolved = path.join(entry, command);
    try {
      await access(resolved, constants.X_OK);
      return resolved;
    } catch {
      // Continue probing PATH entries.
    }
  }
  return null;
}

async function findChrome(): Promise<string> {
  for (const candidate of chromeCandidates) {
    const resolved = await isExecutable(candidate);
    if (resolved) return resolved;
  }

  throw new Error(
    'Chrome/Chromium executable not found. Install Google Chrome/Chromium or set CHROME_PATH to the executable path.',
  );
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function safeResolve(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const normalized = path.normalize(decoded).replace(/^[/\\]+/, '');
  const requested = path.resolve(distDir, normalized);
  const relative = path.relative(distDir, requested);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return requested;
}

async function fileForRequest(urlPath: string): Promise<string | null> {
  let requested = safeResolve(urlPath);
  if (!requested) return null;

  try {
    const info = await stat(requested);
    if (info.isDirectory()) requested = path.join(requested, 'index.html');
  } catch {
    if (!path.extname(requested)) requested = path.join(requested, 'index.html');
  }

  try {
    const info = await stat(requested);
    return info.isFile() ? requested : null;
  } catch {
    return null;
  }
}

function startStaticServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (request, response) => {
    try {
      const filePath = await fileForRequest(request.url ?? '/');
      if (!filePath) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }

      response.writeHead(200, { 'content-type': contentType(filePath) });
      createReadStream(filePath).pipe(response);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to determine local server address.'));
        return;
      }
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function assertFetchOk(url: string, label: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} is not reachable at ${url} (HTTP ${response.status}).`);
  }
  return response;
}

async function requiredAssetPaths(extraAssetPaths: string[]): Promise<string[]> {
  const assets = [...extraAssetPaths];
  const astroDir = path.join(distDir, '_astro');
  try {
    const entries = await readdir(astroDir);
    const css = entries.find((entry) => entry.endsWith('.css'));
    if (css) assets.push(`/_astro/${css}`);
  } catch {
    // Public image checks still verify root-relative asset serving.
  }
  return assets;
}

function onceSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
}

type DevToolsParams = Record<string, unknown>;
type DevToolsResult = Record<string, unknown>;
type DevToolsMessage = { id?: number; result?: DevToolsResult; error?: { message?: string } };

let devToolsCommandId = 1;

function sendDevToolsCommand(
  socket: WebSocket,
  method: string,
  params: DevToolsParams = {},
): Promise<DevToolsResult> {
  const id = devToolsCommandId++;
  socket.send(JSON.stringify({ id, method, params }));

  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as DevToolsMessage;
      if (message.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (message.error) {
        reject(new Error(`${method} failed: ${message.error.message ?? 'Unknown DevTools error'}`));
        return;
      }
      resolve(message.result ?? {});
    };

    socket.addEventListener('message', onMessage);
  });
}

type ChromeTarget = { type?: string; webSocketDebuggerUrl?: string };

async function waitForPageTarget(debugOrigin: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${debugOrigin}/json/list`);
    if (response.ok) {
      const targets = (await response.json()) as ChromeTarget[];
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Chrome DevTools page target.');
}

async function waitForReadyState(socket: WebSocket, pageLabel: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await sendDevToolsCommand(socket, 'Runtime.evaluate', {
      expression: `
        document.readyState === 'complete' &&
        Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0)
      `,
      returnByValue: true,
    });
    const runtimeResult = result.result as { value?: unknown } | undefined;
    if (runtimeResult?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${pageLabel} and images to finish loading.`);
}

async function writeFullPagePdf(socket: WebSocket, outputPdf: string): Promise<void> {
  const result = await sendDevToolsCommand(socket, 'Page.printToPDF', {
    displayHeaderFooter: false,
    printBackground: true,
    preferCSSPageSize: true,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
  });

  if (typeof result.data !== 'string') {
    throw new Error('Chrome did not return PDF data.');
  }

  await writeFile(outputPdf, Buffer.from(result.data, 'base64'));
}

function waitForDevToolsEndpoint(
  child: ChildProcessByStdio<null, null, Readable>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for Chrome DevTools endpoint. ${stderr.trim()}`));
    }, 10_000);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      const browserWs = match[1];
      const url = new URL(browserWs);
      resolve(`${url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}`);
    });

    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`Chrome exited before DevTools was ready (exit code ${code}). ${stderr.trim()}`),
      );
    });
  });
}

function waitForProcessExit(child: ChildProcessByStdio<null, null, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function removeDirectoryWithRetry(directory: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 120));
    }
  }
}

async function runChrome(
  chromePath: string,
  pageUrl: string,
  outputPdf: string,
  pageLabel: string,
): Promise<void> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'page-pdf-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--run-all-compositor-stages-before-draw',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];

  const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket: WebSocket | undefined;
  try {
    const debugOrigin = await waitForDevToolsEndpoint(child);
    const pageWs = await waitForPageTarget(debugOrigin);
    socket = new WebSocket(pageWs);
    await onceSocketOpen(socket);
    await sendDevToolsCommand(socket, 'Page.enable');
    await sendDevToolsCommand(socket, 'Page.navigate', { url: pageUrl });
    await waitForReadyState(socket, pageLabel);
    await writeFullPagePdf(socket, outputPdf);
  } finally {
    if (socket) socket.close();
    if (!child.killed) child.kill('SIGTERM');
    await waitForProcessExit(child);
    await removeDirectoryWithRetry(userDataDir);
  }
}

async function assertPdfCreated(outputPdf: string): Promise<void> {
  const info = await stat(outputPdf);
  if (info.size < 1024) {
    throw new Error(`Generated PDF is unexpectedly small (${info.size} bytes): ${outputPdf}`);
  }

  const file = await import('node:fs/promises');
  const handle = await file.open(outputPdf, 'r');
  try {
    const buffer = Buffer.alloc(4);
    await handle.read(buffer, 0, 4, 0);
    if (buffer.toString() !== '%PDF') {
      throw new Error(`Generated file does not start with a PDF header: ${outputPdf}`);
    }
  } finally {
    await handle.close();
  }
}

type ExportPagePdfOptions = {
  route: `/${string}/`;
  distSubdir: string;
  outputFileName: string;
  pageLabel: string;
  requiredAssetPaths?: string[];
};

const pageConfigs = {
  resume: {
    route: '/resume/',
    distSubdir: 'resume',
    outputFileName: 'resume.pdf',
    pageLabel: 'Resume page',
    requiredAssetPaths: ['/github.png', '/linkedin.png'],
  },
  experience: {
    route: '/experience/',
    distSubdir: 'experience',
    outputFileName: 'experience.pdf',
    pageLabel: 'Experience page',
    requiredAssetPaths: ['/github.png', '/linkedin.png'],
  },
} satisfies Record<string, ExportPagePdfOptions>;

type PageName = keyof typeof pageConfigs;

function isPageName(value: string | undefined): value is PageName {
  return value !== undefined && value in pageConfigs;
}

function usage(): string {
  return `Usage: node scripts/export-page-pdf.ts <${Object.keys(pageConfigs).join('|')}>`;
}

export function optionsForPage(pageName: PageName): ExportPagePdfOptions {
  return pageConfigs[pageName];
}

export async function exportPagePdf({
  route,
  distSubdir,
  outputFileName,
  pageLabel,
  requiredAssetPaths: requiredAssets = [],
}: ExportPagePdfOptions): Promise<void> {
  const chromePath = await findChrome();
  const pageHtml = path.join(distDir, distSubdir, 'index.html');
  const outputPdf = path.join(outputsDir, outputFileName);
  await access(pageHtml, constants.R_OK);
  await mkdir(outputsDir, { recursive: true });

  const { server, origin } = await startStaticServer();
  try {
    const pageUrl = `${origin}${route}`;
    await assertFetchOk(pageUrl, pageLabel);
    for (const assetPath of await requiredAssetPaths(requiredAssets)) {
      await assertFetchOk(`${origin}${assetPath}`, `Built asset ${assetPath}`);
    }
    await runChrome(chromePath, pageUrl, outputPdf, pageLabel);
    await assertPdfCreated(outputPdf);
    console.log(
      `${pageLabel.replace(/ page$/i, '')} PDF written to ${path.relative(rootDir, outputPdf)}`,
    );
  } finally {
    server.close();
  }
}

async function main(): Promise<void> {
  const pageName = process.argv[2];
  if (!isPageName(pageName)) {
    throw new Error(`${usage()}\nUnknown page: ${pageName ?? '(missing)'}`);
  }

  await exportPagePdf(optionsForPage(pageName));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
