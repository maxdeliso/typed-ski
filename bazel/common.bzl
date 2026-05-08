def shell_quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"


def batch_quote(value):
    escaped = value.replace("^", "^^")
    escaped = escaped.replace("%", "%%")
    escaped = escaped.replace('"', '""')
    return '"' + escaped + '"'


def shell_dquote_literal(value):
    escaped = value.replace("\\", "\\\\")
    escaped = escaped.replace('"', '\\"')
    escaped = escaped.replace("$", "\\$")
    escaped = escaped.replace("`", "\\`")
    return escaped


def normalize_runfiles_path(path):
    if path.startswith("../"):
        return path[3:]
    return path


def merge_target_runfiles(runfiles, targets):
    for target in targets:
        default_info = target[DefaultInfo]
        runfiles = runfiles.merge(default_info.default_runfiles)
        runfiles = runfiles.merge(default_info.data_runfiles)
    return runfiles


def powershell_dquote_literal(value):
    escaped = value.replace("`", "``")
    escaped = escaped.replace("$", "`$")
    escaped = escaped.replace('"', '`"')
    escaped = escaped.replace("\r", "`r")
    escaped = escaped.replace("\n", "`n")
    return '"' + escaped + '"'


def sh_single_quote_literal(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"