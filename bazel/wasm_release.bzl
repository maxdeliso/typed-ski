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

    native.genrule(
        name = name,
        srcs = srcs,
        outs = [name + ".wasm"],
        cmd_bash = "\"$(execpath @zig_sdk//:zig)\" cc %s -o \"$@\" %s" % (flag_string, src_locations),
        cmd_bat = "$(execpath @zig_sdk//:zig) cc %s -o $@ %s" % (flag_string, src_locations),
        tools = ["@zig_sdk//:zig"],
        visibility = visibility,
    )
