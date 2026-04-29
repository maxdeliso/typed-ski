_WASM_EXPORTS = [
    "allocCons",
    "allocTerminal",
    "allocU8",
    "arenaKernelStep",
    "connectArena",
    "debugCalculateArenaSize",
    "debugGetArenaBaseAddr",
    "debugGetRingEntries",
    "debugLockState",
    "getArenaMode",
    "hostPullV2",
    "hostSubmit",
    "initArena",
    "kindOf",
    "leftOf",
    "reduce",
    "reset",
    "rightOf",
    "symOf",
    "workerLoop",
]

_WASM_PAGE_SIZE = 64 * 1024
_WASM_INITIAL_PAGES = 257
_WASM_MAX_PAGES = 65535

def _export_flags():
    return ["-Wl,--export=%s" % symbol for symbol in _WASM_EXPORTS]

def _wasm_release_impl(ctx):
    wasm = ctx.actions.declare_file(ctx.label.name + ".wasm")
    zig_cache = ctx.actions.declare_directory(ctx.label.name + ".zig-cache")

    args = ctx.actions.args()
    args.add("cc")
    for header in ctx.files.hdrs:
        args.add("-I%s" % header.dirname)
    args.add_all([
        "-O3",
        "-DNDEBUG",
        "-std=c11",
        "-target",
        "wasm32-wasi",
        "-matomics",
        "-mbulk-memory",
        "-nostdlib",
        "-Wl,--no-entry",
        "-Wl,--import-memory",
        "-Wl,--shared-memory",
        "-Wl,--initial-memory=0x%x" % (_WASM_INITIAL_PAGES * _WASM_PAGE_SIZE),
        "-Wl,--max-memory=0x%x" % (_WASM_MAX_PAGES * _WASM_PAGE_SIZE),
    ])
    args.add_all(_export_flags())
    args.add("-o")
    args.add(wasm)
    args.add_all(ctx.files.srcs)

    ctx.actions.run(
        executable = ctx.file._zig,
        arguments = [args],
        inputs = ctx.files.srcs + ctx.files.hdrs,
        outputs = [wasm, zig_cache],
        env = {
            "ZIG_GLOBAL_CACHE_DIR": "%s/global" % zig_cache.path,
            "ZIG_LOCAL_CACHE_DIR": "%s/local" % zig_cache.path,
        },
        mnemonic = "WasmRelease",
        progress_message = "Building WASM release %{output}",
    )

    return [DefaultInfo(files = depset([wasm]))]

_wasm_release = rule(
    implementation = _wasm_release_impl,
    attrs = {
        "hdrs": attr.label_list(allow_files = [".h"]),
        "srcs": attr.label_list(allow_files = [".c"]),
        "_zig": attr.label(
            default = "@zig_sdk//:zig",
            allow_single_file = True,
            cfg = "exec",
        ),
    },
)

def wasm_release(name, srcs, hdrs = [], visibility = None):
    _wasm_release(
        name = name,
        srcs = srcs,
        hdrs = hdrs,
        visibility = visibility,
    )
