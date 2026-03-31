#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-run

import {
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  resolve,
} from "std/path";

/**
 * Simple HTTP server for WASM profiling demo
 * Sets required headers for SharedArrayBuffer support
 * Serves from project root to access wasm/ directory
 * Expects pre-bundled JavaScript files for any TypeScript requests.
 */

const PORT = parseInt(Deno.args[0] || "8080", 10);

// Get project root (parent of server/)
const serverDirPath = dirname(fromFileUrl(import.meta.url));
const projectRootPath = Deno.realPathSync(resolve(serverDirPath, ".."));

function isWithinProjectRoot(path: string): boolean {
  const relPath = relative(projectRootPath, path);
  return relPath === "" ||
    (!relPath.startsWith("..") && relPath !== ".." && !isAbsolute(relPath));
}

// Base headers for SharedArrayBuffer support (reused across requests)
const baseHeaders = new Headers({
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
});

function createHeaders(contentType: string, contentLength?: string): Headers {
  const headers = new Headers(baseHeaders);
  headers.set("Content-Type", contentType);
  if (contentLength !== undefined) {
    headers.set("Content-Length", contentLength);
  }
  return headers;
}

// Fixed lookup table for content types
const contentTypeTable: Record<string, string> = {
  ".html": "text/html",
  ".wasm": "application/wasm",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function getContentType(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "text/plain";
  const ext = filePath.substring(lastDot);
  return contentTypeTable[ext] || "text/plain";
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
  const fullPathString = resolve(projectRootPath, localPath);

  try {
    // Block path traversal attempts before touching the filesystem.
    if (!isWithinProjectRoot(fullPathString)) {
      return new Response("Forbidden", { status: 403 });
    }

    // Resolve symlinks and ensure the final target is still inside the project root.
    const resolvedPath = await Deno.realPath(fullPathString);
    if (!isWithinProjectRoot(resolvedPath)) {
      return new Response("Forbidden", { status: 403 });
    }

    // Check if file exists
    const stat = await Deno.stat(resolvedPath);

    // Handle TypeScript files by serving the matching pre-bundled JS from dist/.
    if (localPath.endsWith(".ts") || localPath.endsWith(".tsx")) {
      const bundleFileName = localPath.substring(localPath.lastIndexOf("/") + 1)
        .replace(/\.tsx?$/, ".js");
      const jsPath = join(projectRootPath, "dist", bundleFileName);

      try {
        const jsContent = await Deno.readTextFile(jsPath);
        const headers = createHeaders("application/javascript");
        return new Response(jsContent, { headers });
      } catch (_e) {
        const errorMsg =
          `Error: Pre-bundled JavaScript file not found for ${localPath}.\n` +
          `Expected at: ${jsPath}\n\n` +
          `The workbench now serves browser bundles from dist/. ` +
          `Please run 'bazelisk run //:hephaestus_assets' ` +
          `or 'bazelisk run //:serve_hephaestus' to generate the necessary artifacts.`;

        console.error(errorMsg);
        return new Response(errorMsg, {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    // For other files, serve as-is
    const file = await Deno.open(resolvedPath, { read: true });
    const content = file.readable;

    // Determine content type
    const contentType = getContentType(localPath);

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
