target triple = "x86_64-pc-windows-msvc"

declare i8 @trip_fn_Main_main()

declare dllimport ptr @GetStdHandle(i32)
declare dllimport i32 @ReadFile(ptr, ptr, i32, ptr, ptr)
declare dllimport i32 @WriteFile(ptr, ptr, i32, ptr, ptr)
declare dllimport void @ExitProcess(i32)

define dso_local void @trip_start() {
entry:
  %trip_result = call i8 @trip_fn_Main_main()
  %exit_code = zext i8 %trip_result to i32
  call void @ExitProcess(i32 %exit_code)
  unreachable
}

define dso_local i8 @trip_read_one() {
entry:
  %byte = alloca i8, align 1
  %bytes_read = alloca i32, align 4
  store i8 0, ptr %byte, align 1
  store i32 0, ptr %bytes_read, align 4
  %stdin = call ptr @GetStdHandle(i32 -10)
  %ok = call i32 @ReadFile(ptr %stdin, ptr %byte, i32 1, ptr %bytes_read, ptr null)
  %ok_bool = icmp ne i32 %ok, 0
  %count = load i32, ptr %bytes_read, align 4
  %read_one = icmp eq i32 %count, 1
  %success = and i1 %ok_bool, %read_one
  br i1 %success, label %read, label %eof

read:
  %value = load i8, ptr %byte, align 1
  ret i8 %value

eof:
  ret i8 0
}

define dso_local void @trip_write_one(i8 %byte_value) {
entry:
  %byte = alloca i8, align 1
  %bytes_written = alloca i32, align 4
  store i8 %byte_value, ptr %byte, align 1
  store i32 0, ptr %bytes_written, align 4
  %stdout = call ptr @GetStdHandle(i32 -11)
  %ignored = call i32 @WriteFile(ptr %stdout, ptr %byte, i32 1, ptr %bytes_written, ptr null)
  ret void
}
