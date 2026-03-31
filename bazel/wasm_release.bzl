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

_ZIG_CACHE_PATH_LINUX = "/tmp/zig-cache"
_ZIG_CACHE_PATH_WINDOWS = "C:/Temp/zig-cache"

def wasm_release(name, srcs, visibility = None):
    flags = [
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
    ] + _export_flags()
    src_locations = " ".join(["$(location %s)" % src for src in srcs])
    flag_string = " ".join(flags)

    # We explicitly set ZIG_LOCAL_CACHE_DIR and ZIG_GLOBAL_CACHE_DIR to avoid
    # AppDataDirUnavailable errors in CI environments where the default cache
    # locations (like $HOME/.cache or %APPDATA%) might not be writable or available.
    cmd_bash = "export ZIG_LOCAL_CACHE_DIR={cache} && export ZIG_GLOBAL_CACHE_DIR={cache} && \"$(execpath @zig_sdk//:zig)\" cc {flags} -o \"$@\" {srcs}".format(
        cache = _ZIG_CACHE_PATH_LINUX,
        flags = flag_string,
        srcs = src_locations,
    )

    cmd_bat = "set ZIG_LOCAL_CACHE_DIR={cache}&& set ZIG_GLOBAL_CACHE_DIR={cache}&& $(execpath @zig_sdk//:zig) cc {flags} -o $@ {srcs}".format(
        cache = _ZIG_CACHE_PATH_WINDOWS,
        flags = flag_string,
        srcs = src_locations,
    )

    native.genrule(
        name = name,
        srcs = srcs,
        outs = [name + ".wasm"],
        cmd_bash = cmd_bash,
        cmd_bat = cmd_bat,
        tools = ["@zig_sdk//:zig"],
        visibility = visibility,
    )
