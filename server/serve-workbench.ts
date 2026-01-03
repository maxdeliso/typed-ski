#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-run --allow-run
/**
 * Simple HTTP server for WASM profiling demo
 * Sets required headers for SharedArrayBuffer support
 * Serves from project root to access wasm/ directory
 * Transpiles TypeScript to JavaScript on the fly for browser compatibility
 */

const PORT = parseInt(Deno.args[0] || "8080", 10);

// Get project root (parent of server/)
// This script is in server/, so project root is parent directory
const serverFileUrl = import.meta.url;
const serverDirUrl = new URL(".", serverFileUrl);
const projectRootUrl = new URL("..", serverDirUrl);

async function transpileTypeScript(filePath: string): Promise<string> {
  try {
    // Use deno bundle to transpile TypeScript to JavaScript
    // This bundles the file and all its dependencies into a single JS file
    // Use --no-check to avoid type checking issues and ensure browser compatibility
    const bundleProcess = new Deno.Command(Deno.execPath(), {
      args: [
        "bundle",
        "--no-check",
        "--platform=browser",
        filePath,
      ],
      stdout: "piped",
      stderr: "piped",
      cwd: projectRootUrl.pathname,
    });

    const { code, stdout, stderr } = await bundleProcess.output();

    if (code !== 0) {
      const errorText = new TextDecoder().decode(stderr);
      throw new Error(`Bundle failed: ${errorText}`);
    }

    const jsContent = new TextDecoder().decode(stdout);
    return jsContent;
  } catch (error) {
    console.error(`Transpilation error for ${filePath}:`, error);
    throw error;
  }
}

// Base headers for SharedArrayBuffer support
function createHeaders(contentType: string, contentLength?: string): Headers {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  if (contentLength !== undefined) {
    headers.set("Content-Length", contentLength);
  }
  return headers;
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let filePath = url.pathname;

  // Default to workbench.html
  if (filePath === "/") {
    filePath = "/server/workbench.html";
  }

  // Map /workbench.html to /server/workbench.html for convenience
  if (filePath === "/workbench.html") {
    filePath = "/server/workbench.html";
  }

  // Remove leading slash and resolve from project root
  const localPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

  // Resolve to absolute path from project root
  const fullPath = new URL(localPath, projectRootUrl);
  const fullPathString = fullPath.pathname;

  try {
    // Check if file exists
    const stat = await Deno.stat(fullPathString);

    // Handle TypeScript files - transpile to JavaScript
    if (localPath.endsWith(".ts") || localPath.endsWith(".tsx")) {
      try {
        const jsContent = await transpileTypeScript(fullPathString);

        const headers = createHeaders("application/javascript");
        return new Response(jsContent, { headers });
      } catch (transpileError) {
        console.error(
          `Transpilation error for ${fullPathString}:`,
          transpileError,
        );
        const errorMessage = transpileError instanceof Error
          ? transpileError.message
          : String(transpileError);
        const errorStack = transpileError instanceof Error
          ? transpileError.stack
          : "";
        return new Response(
          `Error transpiling TypeScript: ${errorMessage}\n\n${errorStack}`,
          {
            status: 500,
            headers: {
              "Content-Type": "text/plain",
            },
          },
        );
      }
    }

    // For other files, serve as-is
    const file = await Deno.open(fullPathString, { read: true });
    const content = file.readable;

    // Determine content type
    let contentType = "text/plain";
    if (localPath.endsWith(".html")) contentType = "text/html";
    else if (localPath.endsWith(".wasm")) contentType = "application/wasm";
    else if (localPath.endsWith(".js")) contentType = "application/javascript";
    else if (localPath.endsWith(".css")) contentType = "text/css";
    else if (localPath.endsWith(".json")) contentType = "application/json";

    // Required headers for SharedArrayBuffer
    const headers = createHeaders(contentType, stat.size.toString());

    return new Response(content, { headers });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not Found", { status: 404 });
    }
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(`Error: ${msg}`, { status: 500 });
  }
}

const url = `http://localhost:${PORT}/workbench.html`;
console.log(`Starting server...`);
console.log(`\n  ${url}\n`);
console.log("Press Ctrl+C to stop\n");

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, handler);
