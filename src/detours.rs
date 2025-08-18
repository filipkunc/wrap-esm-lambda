use ctor::ctor;
use frida_gum::{Gum, Module, NativePointer, interceptor::Interceptor};
use lazy_static::lazy_static;
use libc::{c_char, c_int, c_void};
use libc::{c_long, c_ulong};
use napi_derive::napi;
use std::cell::UnsafeCell;
use std::fs::read_to_string;
use std::sync::Mutex;
use std::sync::OnceLock;

pub mod transform;

lazy_static! {
  static ref ORIGINAL_OPEN: Mutex<UnsafeCell<Option<OpenFunc>>> = Mutex::new(UnsafeCell::new(None));
  static ref ORIGINAL_CLOSE: Mutex<UnsafeCell<Option<CloseFunc>>> =
    Mutex::new(UnsafeCell::new(None));
  static ref ORIGINAL_READ: Mutex<UnsafeCell<Option<ReadFunc>>> = Mutex::new(UnsafeCell::new(None));
  static ref ORIGINAL_UV_FS_FSTAT: Mutex<UnsafeCell<Option<UvFsFstatFunc>>> =
    Mutex::new(UnsafeCell::new(None));
}

type OpenFunc = unsafe extern "C" fn(*const c_char, flags: c_int) -> c_int;
type CloseFunc = unsafe extern "C" fn(fd: c_int) -> c_int;
type ReadFunc = unsafe extern "C" fn(fd: c_int, buf: *mut c_void, count: c_ulong) -> c_long;

// int uv_fs_fstat(uv_loop_t* loop, uv_fs_t* req, uv_file file, uv_fs_cb cb)
type UvFsFstatFunc = unsafe extern "C" fn(
  r#loop: *mut c_void,           // uv_loop_t* loop
  req: *mut libuv_sys2::uv_fs_t, // uv_fs_t* req
  file: c_int,                   // uv_file file
  cb: NativePointer,             // uv_fs_cb
) -> c_int;

struct GlobalState {
  handler_fd: i32,
  transformed: String,
}

static STATE: Mutex<GlobalState> = Mutex::new(GlobalState {
  handler_fd: 0,
  transformed: String::new(),
});

unsafe extern "C" fn open_detour(name: *const c_char, flags: c_int) -> c_int {
  let path = unsafe { std::ffi::CStr::from_ptr(name) }.to_str().unwrap();
  if path.ends_with("handler.mjs") {
    let fd = unsafe {
      ORIGINAL_OPEN
        .lock()
        .unwrap()
        .get()
        .as_ref()
        .unwrap()
        .unwrap()(name, flags)
    };

    let content = read_to_string(path);
    STATE.lock().unwrap().transformed = transform::transform_lambda_source(
      content.unwrap(),
      "handler".to_string(),
      "WrapAwsLambda".to_string(),
    );
    STATE.lock().unwrap().handler_fd = fd;
    return fd;
  }
  unsafe {
    ORIGINAL_OPEN
      .lock()
      .unwrap()
      .get()
      .as_ref()
      .unwrap()
      .unwrap()(name, flags)
  }
}

unsafe extern "C" fn close_detour(fd: c_int) -> c_int {
  let res = unsafe {
    ORIGINAL_CLOSE
      .lock()
      .unwrap()
      .get()
      .as_ref()
      .unwrap()
      .unwrap()(fd)
  };
  if fd == STATE.lock().unwrap().handler_fd {
    STATE.lock().unwrap().handler_fd = 0;
  }
  res
}

unsafe extern "C" fn read_detour(fd: c_int, buf: *mut c_void, count: c_ulong) -> c_long {
  if fd == STATE.lock().unwrap().handler_fd {
    let dst = unsafe { std::slice::from_raw_parts_mut(buf as *mut u8, count as usize) };
    let mut src = String::new();
    STATE.lock().unwrap().transformed.clone_into(&mut src);
    dst.clone_from_slice(src.as_bytes());
    count as i64
  } else {
    unsafe {
      ORIGINAL_READ
        .lock()
        .unwrap()
        .get()
        .as_ref()
        .unwrap()
        .unwrap()(fd, buf, count)
    }
  }
}

unsafe extern "C" fn uv_fs_fstat_detour(
  r#loop: *mut c_void,
  req: *mut libuv_sys2::uv_fs_t,
  file: c_int,
  cb: NativePointer,
) -> c_int {
  let res = unsafe {
    ORIGINAL_UV_FS_FSTAT
      .lock()
      .unwrap()
      .get()
      .as_ref()
      .unwrap()
      .unwrap()(r#loop, req, file, cb)
  };
  if file == STATE.lock().unwrap().handler_fd {
    let new_size = STATE.lock().unwrap().transformed.len();
    let my_ref = unsafe { req.as_mut() }.unwrap();
    my_ref.statbuf.st_size = new_size as u64;
  }
  res
}

#[ctor]
fn init() {
  let key = "LD_PRELOAD";
  if let Ok(val) = std::env::var(key) {
    install_hooks()
  }
}

#[napi]
pub fn install_hooks() {
  static CELL: OnceLock<Gum> = OnceLock::new();
  let gum = CELL.get_or_init(Gum::obtain);
  let module = Module::load(gum, "libc.so.6");
  let mut interceptor = Interceptor::obtain(gum);
  let open = module.find_export_by_name("open").unwrap();
  let close = module.find_export_by_name("close").unwrap();
  let read = module.find_export_by_name("read").unwrap();
  let uv_fs_fstat = Module::find_global_export_by_name("uv_fs_fstat").unwrap();
  unsafe {
    *ORIGINAL_OPEN.lock().unwrap().get_mut() = Some(std::mem::transmute::<
      *mut libc::c_void,
      unsafe extern "C" fn(*const i8, i32) -> i32,
    >(
      interceptor
        .replace(
          open,
          NativePointer(open_detour as *mut c_void),
          NativePointer(std::ptr::null_mut()),
        )
        .unwrap()
        .0,
    ));
    *ORIGINAL_CLOSE.lock().unwrap().get_mut() = Some(std::mem::transmute::<
      *mut libc::c_void,
      unsafe extern "C" fn(c_int) -> c_int,
    >(
      interceptor
        .replace(
          close,
          NativePointer(close_detour as *mut c_void),
          NativePointer(std::ptr::null_mut()),
        )
        .unwrap()
        .0,
    ));
    *ORIGINAL_READ.lock().unwrap().get_mut() = Some(std::mem::transmute::<
      *mut libc::c_void,
      unsafe extern "C" fn(c_int, *mut c_void, c_ulong) -> c_long,
    >(
      interceptor
        .replace(
          read,
          NativePointer(read_detour as *mut c_void),
          NativePointer(std::ptr::null_mut()),
        )
        .unwrap()
        .0,
    ));
    *ORIGINAL_UV_FS_FSTAT.lock().unwrap().get_mut() = Some(std::mem::transmute::<
      *mut libc::c_void,
      unsafe extern "C" fn(
        *mut c_void,              // uv_loop_t* loop
        *mut libuv_sys2::uv_fs_t, // uv_fs_t* req
        c_int,                    // uv_file file
        NativePointer,            // uv_fs_cb
      ) -> c_int,
    >(
      interceptor
        .replace(
          uv_fs_fstat,
          NativePointer(uv_fs_fstat_detour as *mut c_void),
          NativePointer(std::ptr::null_mut()),
        )
        .unwrap()
        .0,
    ));
  }
}
