target triple = "x86_64-unknown-linux-gnu"

declare void @trip_write_one(i8) nounwind

define i8 @trip_fn_Main_main() local_unnamed_addr nounwind {
entry:
  %rt_ptr_trip_write_one = bitcast ptr @trip_write_one to ptr
  call void %rt_ptr_trip_write_one(i8 72)
  call void %rt_ptr_trip_write_one(i8 101)
  call void %rt_ptr_trip_write_one(i8 108)
  call void %rt_ptr_trip_write_one(i8 108)
  call void %rt_ptr_trip_write_one(i8 111)
  call void %rt_ptr_trip_write_one(i8 44)
  call void %rt_ptr_trip_write_one(i8 32)
  call void %rt_ptr_trip_write_one(i8 119)
  call void %rt_ptr_trip_write_one(i8 111)
  call void %rt_ptr_trip_write_one(i8 114)
  call void %rt_ptr_trip_write_one(i8 108)
  call void %rt_ptr_trip_write_one(i8 100)
  call void %rt_ptr_trip_write_one(i8 33)
  call void %rt_ptr_trip_write_one(i8 10)
  ret i8 10
}

define i32 @main() {
entry:
  %trip_result = call i8 @trip_fn_Main_main()
  %exit_code = zext i8 %trip_result to i32
  ret i32 %exit_code
}
