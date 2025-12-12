//! Arena-based memory management for SKI expressions
//!

#![allow(dead_code)]

/// Arena node kind
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArenaKind {
    Terminal = 1,
    NonTerm = 2,
}

/// SKI combinator symbols
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArenaSym {
    S = 1,
    K = 2,
    I = 3,
}

const EMPTY: u32 = 0xffff_ffff;

/// Magic constant to verify arena integrity (ASCII-ish for 'SKIA')
const ARENA_MAGIC: u32 = 0x534B_4941;

const INITIAL_CAP: u32 = 1 << 20; // ~1,048,576 nodes
const MAX_CAP: u32 = 1 << 27; // 134,217,728 nodes (~3.2GB at ~24B/node, fits under 4GB limit)

/// Global arena base address (instance-local).
/// - In SAB Mode: Points to shared memory provided by Host.
/// - In Heap Mode: Points to local memory we allocated lazily.
#[cfg(target_arch = "wasm32")]
#[allow(static_mut_refs)]
static mut ARENA_BASE_ADDR: u32 = 0;

/// Arena mode tracking (instance-local).
/// - 0: Not initialized or heap mode (lazy allocation)
/// - 1: SAB mode (connected to shared memory)
#[cfg(target_arch = "wasm32")]
#[allow(static_mut_refs)]
static mut ARENA_MODE: u32 = 0;

/// Lock acquisition tracking (for debugging)
#[cfg(target_arch = "wasm32")]
#[allow(static_mut_refs)]
static mut LOCK_ACQUISITION_COUNT: u32 = 0;

/// Lock release tracking (for debugging)
#[cfg(target_arch = "wasm32")]
#[allow(static_mut_refs)]
static mut LOCK_RELEASE_COUNT: u32 = 0;

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32;
#[cfg(target_arch = "wasm32")]
use core::sync::atomic::{AtomicU32, Ordering};


/// Fast 32-bit integer scrambler with good distribution properties
/// Based on MurmurHash3's finalizer (avalanche function)
fn avalanche32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^= x >> 16;
    x
}

/// Donald Knuth's multiplicative hash constant
const GOLD: u32 = 0x9e3779b9;

/// Mix two hash values
fn mix(a: u32, b: u32) -> u32 {
    avalanche32(a ^ b.wrapping_mul(GOLD))
}

/// Get the arena header pointer. If it doesn't exist, lazily initialize a local one.
#[cfg(target_arch = "wasm32")]
#[inline(always)]
fn get_arena() -> *mut SabHeader {
    unsafe {
        if ARENA_BASE_ADDR != 0 {
            return ARENA_BASE_ADDR as *mut SabHeader;
        }

        // Lazy Initialization for Single-Threaded Mode
        // We allocate INITIAL_CAP capacity by default if not told otherwise
        // IMPORTANT: Only allocate if we're not in SAB mode (ARENA_MODE == 1 means SAB mode)
        // If we're in SAB mode but ARENA_BASE_ADDR is 0, that's an error state
        if ARENA_MODE == 1 {
            wasm32::unreachable(); // Fatal: SAB mode but no base address - arena not connected
        }

        let ptr = allocate_raw_arena(INITIAL_CAP);
        if ptr.is_null() {
            wasm32::unreachable(); // Fatal OOM
        }

        ARENA_BASE_ADDR = ptr as u32;
        ARENA_MODE = 0; // Heap mode (lazy allocation)
        ptr
    }
}

// ============================================================================
// SAB header and helpers (wasm32 only)
// ============================================================================
#[cfg(target_arch = "wasm32")]
#[repr(C, align(64))]
struct SabHeader {
    global_lock: u32,   // 0 = unlocked, 1 = locked (no contention), 2 = locked (contention)
    capacity: u32,      // fixed capacity in nodes (max: MAX_CAP = 1<<27 = 134,217,728)
    top: u32,           // next free node index (max: capacity - 1)
    bucket_mask: u32,   // Dynamic mask (capacity - 1) for hash bucket selection
    // Byte offsets from start of header (max: ~2.95 GB at MAX_CAP, fits in u32)
    offset_kind: u32,
    offset_sym: u32,
    offset_left_id: u32,
    offset_right_id: u32,
    offset_hash32: u32,
    offset_next_idx: u32,
    offset_buckets: u32,
    offset_term_cache: u32,
    magic: u32,         // Integrity check
    reserved: u32,      // Padding/Future use
}

#[cfg(target_arch = "wasm32")]
impl SabHeader {
    fn new(capacity: u32) -> Self {
        let header_size = core::mem::size_of::<SabHeader>() as u32;

        // Buckets array is now sized to capacity (load factor ~1.0)
        let buckets_count = capacity;

        let offset_kind = header_size;
        let offset_sym = offset_kind + capacity;

        // Align offsets to 4 bytes
        let align4 = |ptr: u32| (ptr + 3) & !3;

        let offset_left_id = align4(offset_sym + capacity);
        let offset_right_id = offset_left_id + 4 * capacity;
        let offset_hash32 = offset_right_id + 4 * capacity;
        let offset_next_idx = offset_hash32 + 4 * capacity;

        // Buckets array is now variable size (capacity * 4 bytes)
        let offset_buckets = {
            let unaligned = offset_next_idx + 4 * capacity;
            let padding = (64 - (unaligned % 64)) % 64;
            unaligned + padding
        };

        let offset_term_cache = offset_buckets + 4 * buckets_count;

        SabHeader {
            global_lock: 0,
            capacity,
            top: 0,
            bucket_mask: capacity - 1, // Assumes capacity is power of 2
            offset_kind,
            offset_sym,
            offset_left_id,
            offset_right_id,
            offset_hash32,
            offset_next_idx,
            offset_buckets,
            offset_term_cache,
            magic: ARENA_MAGIC,
            reserved: 0,
        }
    }

    #[inline(always)]
    fn lock(&mut self) {
        let ptr = &mut self.global_lock as *mut u32;

        // 1. FAST PATH: Try to grab the lock assuming no contention.
        // We strictly expect 0. If it's 1 or 2, we go to slow path.
        if unsafe { atomic_cxchg_u32(ptr, 0, 1) } == 0 {
            unsafe { LOCK_ACQUISITION_COUNT = LOCK_ACQUISITION_COUNT.wrapping_add(1); }
            return;
        }

        // 2. SLOW PATH: Contention detected.
        self.lock_slow(ptr);

        unsafe { LOCK_ACQUISITION_COUNT = LOCK_ACQUISITION_COUNT.wrapping_add(1); }
    }

    // Cold function to keep the hot path (lock) small for inlining
    #[cold]
    fn lock_slow(&mut self, ptr: *mut u32) {
        let mut spin_count = 0;
        let mut rng_seed = ptr as u32; // Poor man's seed based on address

        loop {
            // A. SPIN PHASE
            // We spin for a short duration to catch locks held for tiny amounts of time.
            // This avoids the overhead of the 'wait' syscall.
            if spin_count < 100 {
                spin_count += 1;

                // Reload value to check state
                let state = unsafe { atomic_load_u32(ptr) };

                // Optimization: Don't try to CAS if we see it's locked.
                // Just spin-loop. This reduces cache coherency traffic (MESI:
                // Modified, Exclusive, Shared, Invalid cache coherency protocol).
                if state != 0 {
                    core::hint::spin_loop();
                    continue;
                }

                // Try to grab it again (0 -> 1)
                if unsafe { atomic_cxchg_u32(ptr, 0, 1) } == 0 {
                    return;
                }

                // Random Backoff (Ethernet style) to prevent thundering herd
                // Simple Xorshift or just using the loop counter + address
                rng_seed ^= rng_seed << 13;
                rng_seed ^= rng_seed >> 17;
                rng_seed ^= rng_seed << 5;

                // Variable spin loop based on "randomness"
                let backoff = (rng_seed % 10) + 1;
                for _ in 0..backoff {
                    core::hint::spin_loop();
                }
                continue;
            }

            // B. PARK PHASE (The "Descheduling")
            // If we are still here, the lock is held for a "long" time.
            // We must mark the state as 2 (Contested) so the unlocker knows to wake us.

            let state = unsafe { atomic_load_u32(ptr) };
            if state == 0 {
                // Just in case it unlocked while we were preparing to sleep
                if unsafe { atomic_cxchg_u32(ptr, 0, 1) } == 0 { return; }
                continue;
            }

            // If state is 1, upgrade to 2 (signal "I am going to sleep")
            if state == 1 {
                if unsafe { atomic_cxchg_u32(ptr, 1, 2) } != 1 {
                    continue; // State changed, retry loop
                }
            }

            // C. SLEEP
            // Execute 'memory.atomic.wait32'.
            // This suspends the thread execution until:
            // 1. Another thread calls memory.atomic.notify on this address.
            // 2. The value at the address is no longer equal to 2 (race check).
            // 3. Optional timeout (we pass -1 for infinite).
            unsafe {
                // Must cast to *mut i32 for the intrinsic
                let ptr_i32 = ptr as *mut i32;
                // Params: (ptr, expected_value, timeout_ns)
                wasm32::memory_atomic_wait32(ptr_i32, 2, -1);
            }

            // After waking up, we loop back to start.
            // We do NOT assume we have the lock. We must try to CAS 0->2 or 0->1 again.
            // Reset spin count to try spinning briefly again upon wake-up.
            spin_count = 0;
        }
    }

    #[inline(always)]
    fn unlock(&mut self) {
        let ptr = &mut self.global_lock as *mut u32;

        // 1. FAST RELEASE
        // Atomically swap 0. We need the previous value to know if we need to wake anyone.
        // We use xchg (swap) instead of store to strictly serialize.
        // If previous was 1, no one was waiting. We are done.
        let prev = unsafe { atomic_xchg_u32(ptr, 0) };

        // 2. WAKE UP (If needed)
        // If previous value was 2, it means threads are sleeping in the kernel.
        if prev == 2 {
            unsafe {
                let ptr_i32 = ptr as *mut i32;
                // Wake up 1 waiter. (Passing u32::MAX would wake all -> thundering herd).
                wasm32::memory_atomic_notify(ptr_i32, 1);
            }
        }

        unsafe { LOCK_RELEASE_COUNT = LOCK_RELEASE_COUNT.wrapping_add(1); }
    }

    #[inline(always)]
    fn load_top(&self) -> u32 {
        let ptr = &self.top as *const u32 as *mut u32;
        atomic_load_u32(ptr)
    }

    #[inline(always)]
    fn store_top(&mut self, val: u32) {
        let ptr = &mut self.top as *mut u32;
        atomic_store_u32(ptr, val);
    }

    // Read a bucket head atomically with Acquire ordering
    // This ensures that if we see a node ID in a bucket, the data for that node is fully visible
    #[inline(always)]
    unsafe fn load_bucket_atomic(&self, bucket_idx: usize) -> u32 {
        let header_ptr = self as *const SabHeader;
        let ptr = buckets_array_ptr(header_ptr).add(bucket_idx) as *mut AtomicU32;
        (&*ptr).load(Ordering::Acquire)
    }

    // Read a next_idx pointer atomically with Acquire ordering
    #[inline(always)]
    unsafe fn load_next_atomic(&self, node_idx: usize) -> u32 {
        let header_ptr = self as *const SabHeader;
        let ptr = next_idx_array_ptr(header_ptr).add(node_idx) as *mut AtomicU32;
        (&*ptr).load(Ordering::Acquire)
    }
}

#[cfg(target_arch = "wasm32")]
#[inline(always)]
fn atomic_load_u32(ptr: *mut u32) -> u32 {
    unsafe {
        // Use AtomicU32 from core::sync::atomic - compiles to i32.atomic.load
        // This is zero-cost and generates the exact same WASM instruction
        (&*(ptr as *const AtomicU32)).load(Ordering::SeqCst)
    }
}

#[cfg(target_arch = "wasm32")]
#[inline(always)]
fn atomic_store_u32(ptr: *mut u32, val: u32) {
    unsafe {
        // Use AtomicU32 from core::sync::atomic - compiles to i32.atomic.store
        // This is zero-cost and generates the exact same WASM instruction
        (&*(ptr as *const AtomicU32)).store(val, Ordering::SeqCst);
    }
}

#[cfg(target_arch = "wasm32")]
#[inline(always)]
fn atomic_cxchg_u32(ptr: *mut u32, current: u32, new: u32) -> u32 {
    unsafe {
        // Use AtomicU32 from core::sync::atomic - compiles to i32.atomic.rmw.cmpxchg
        // This is zero-cost and generates the exact same WASM instruction
        match (&*(ptr as *const AtomicU32)).compare_exchange(
            current,
            new,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(v) => v,
            Err(v) => v,
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[inline(always)]
unsafe fn atomic_xchg_u32(ptr: *mut u32, new: u32) -> u32 {
    // compiles to i32.atomic.rmw.xchg
    (&*(ptr as *const AtomicU32)).swap(new, Ordering::SeqCst)
}

#[cfg(target_arch = "wasm32")]
const HEADER_SIZE: u32 = core::mem::size_of::<SabHeader>() as u32;
#[cfg(target_arch = "wasm32")]
const WASM_PAGE_SIZE: usize = 65536; // 64 KB

#[cfg(target_arch = "wasm32")]
fn kind_array_ptr(header: *const SabHeader) -> *mut u8 {
    unsafe { (header as *mut u8).add((*header).offset_kind as usize) }
}

#[cfg(target_arch = "wasm32")]
fn sym_array_ptr(header: *const SabHeader) -> *mut u8 {
    unsafe { (header as *mut u8).add((*header).offset_sym as usize) }
}

#[cfg(target_arch = "wasm32")]
fn left_id_array_ptr(header: *const SabHeader) -> *mut u32 {
    unsafe { (header as *mut u8).add((*header).offset_left_id as usize) as *mut u32 }
}

#[cfg(target_arch = "wasm32")]
fn right_id_array_ptr(header: *const SabHeader) -> *mut u32 {
    unsafe { (header as *mut u8).add((*header).offset_right_id as usize) as *mut u32 }
}

#[cfg(target_arch = "wasm32")]
fn hash32_array_ptr(header: *const SabHeader) -> *mut u32 {
    unsafe { (header as *mut u8).add((*header).offset_hash32 as usize) as *mut u32 }
}

#[cfg(target_arch = "wasm32")]
fn next_idx_array_ptr(header: *const SabHeader) -> *mut u32 {
    unsafe { (header as *mut u8).add((*header).offset_next_idx as usize) as *mut u32 }
}

#[cfg(target_arch = "wasm32")]
fn buckets_array_ptr(header: *const SabHeader) -> *mut u32 {
    unsafe { (header as *mut u8).add((*header).offset_buckets as usize) as *mut u32 }
}

#[cfg(target_arch = "wasm32")]
fn term_cache_array_ptr(header: *const SabHeader) -> *mut u32 {
    unsafe { (header as *mut u8).add((*header).offset_term_cache as usize) as *mut u32 }
}

#[cfg(target_arch = "wasm32")]
fn calculate_total_arena_size(capacity: u32) -> usize {
    let header = SabHeader::new(capacity);
    (header.offset_term_cache + 16) as usize
}

#[cfg(target_arch = "wasm32")]
unsafe fn allocate_raw_arena(capacity: u32) -> *mut SabHeader {
    let total_size = calculate_total_arena_size(capacity);

    // We strictly use memory_grow. In a threaded WASM environment, this is the
    // single source of truth for atomic allocation. We do not attempt to fit
    // into existing space, as checking bounds without a lock is racy.
    let pages_needed = (total_size + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;

    // Returns the OLD size in pages, which effectively points to the start of our new block
    let old_pages = wasm32::memory_grow(0, pages_needed);

    if old_pages == usize::MAX {
        return core::ptr::null_mut(); // OOM
    }

    let ptr_addr = old_pages * WASM_PAGE_SIZE;
    let header_ptr = ptr_addr as *mut SabHeader;

    // 1. Write Header
    let mut header = SabHeader::new(capacity);
    // Explicitly set magic (redundant with new() but emphasizes intent)
    header.magic = ARENA_MAGIC;
    core::ptr::write(header_ptr, header);

    // 2. Ensure critical fields are visible via atomics immediately
    let capacity_ptr = &mut (*header_ptr).capacity as *mut u32;
    atomic_store_u32(capacity_ptr, capacity);

    let bucket_mask_ptr = &mut (*header_ptr).bucket_mask as *mut u32;
    atomic_store_u32(bucket_mask_ptr, capacity - 1);

    let magic_ptr = &mut (*header_ptr).magic as *mut u32;
    atomic_store_u32(magic_ptr, ARENA_MAGIC);

    // 3. Zero-initialize the data payload
    let arena_data_start = (header_ptr as *mut u8).add(HEADER_SIZE as usize);
    let arena_data_size = total_size - HEADER_SIZE as usize;

    // Efficiently zero memory
    core::ptr::write_bytes(arena_data_start, 0, arena_data_size);

    // 4. Initialize specialized structures
    let buckets_ptr = buckets_array_ptr(header_ptr);
    let buckets_count = capacity as usize; // Dynamic bucket count
    for i in 0..buckets_count {
        *buckets_ptr.add(i) = EMPTY;
    }

    let cache_ptr = term_cache_array_ptr(header_ptr);
    for i in 0..4 {
        *cache_ptr.add(i) = EMPTY;
    }

    header_ptr
}

/// Grow the arena to a new capacity. Must be called with the lock held.
/// Returns true if growth succeeded, false if it failed (e.g., already at MAX_CAP or OOM).
/// This function rebuilds the hash table (buckets/next_idx) instead of moving them,
/// which maintains O(1) performance at any scale.
#[cfg(target_arch = "wasm32")]
unsafe fn grow_arena(header_ptr: *mut SabHeader) -> bool {
    let header = &*header_ptr;
    let old_capacity = header.capacity;
    let top = header.load_top(); // We need 'top' to know how many nodes to rehash

    // Check if we can grow
    if old_capacity >= MAX_CAP {
        return false; // Already at max capacity
    }

    // Double the capacity (or cap at MAX_CAP)
    let new_capacity = (old_capacity * 2).min(MAX_CAP);
    if new_capacity == old_capacity {
        return false; // Can't grow further
    }

    // 1. Grow Memory
    let new_total_size = calculate_total_arena_size(new_capacity);
    let header_addr = header_ptr as usize;
    let current_mem_pages = wasm32::memory_size(0);
    let current_mem_bytes = current_mem_pages * WASM_PAGE_SIZE;
    let needed_mem_bytes = header_addr + new_total_size;

    if needed_mem_bytes > current_mem_bytes {
        let bytes_needed = needed_mem_bytes - current_mem_bytes;
        let pages_needed = (bytes_needed + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;
        if wasm32::memory_grow(0, pages_needed) == usize::MAX {
            return false; // OOM
        }
    }
    let new_mem_bytes = wasm32::memory_size(0) * WASM_PAGE_SIZE;

    // 2. Prepare Layouts
    let new_header_layout = SabHeader::new(new_capacity);
    let old_header_layout = SabHeader::new(old_capacity);

    // 3. Move Data Arrays (Kind, Sym, Left, Right, Hash)
    // NOTE: We do NOT move Buckets or NextIdx. We will rebuild them.
    let move_array = |old_offset: u32, new_offset: u32, element_size: usize, count: usize| {
        if old_offset == new_offset {
            return; // Optimization: No move needed
        }
        let size_bytes = count * element_size;
        let src = (header_ptr as *mut u8).add(old_offset as usize);
        let dst = (header_ptr as *mut u8).add(new_offset as usize);
        // Safety check
        if header_addr + new_offset as usize + size_bytes > new_mem_bytes {
            wasm32::unreachable();
        }
        core::ptr::copy(src, dst, size_bytes);
    };

    // Move in reverse order of NEW offsets to be safe, though copy() handles overlap
    move_array(
        old_header_layout.offset_term_cache,
        new_header_layout.offset_term_cache,
        4,
        4,
    );
    // Skip buckets - we'll rebuild them
    // Skip next_idx - we'll rebuild them
    move_array(
        old_header_layout.offset_hash32,
        new_header_layout.offset_hash32,
        4,
        old_capacity as usize,
    );
    move_array(
        old_header_layout.offset_right_id,
        new_header_layout.offset_right_id,
        4,
        old_capacity as usize,
    );
    move_array(
        old_header_layout.offset_left_id,
        new_header_layout.offset_left_id,
        4,
        old_capacity as usize,
    );
    move_array(
        old_header_layout.offset_sym,
        new_header_layout.offset_sym,
        1,
        old_capacity as usize,
    );
    move_array(
        old_header_layout.offset_kind,
        new_header_layout.offset_kind,
        1,
        old_capacity as usize,
    );

    // 4. Update Header pointers (so our helper functions point to the NEW arrays)
    (*header_ptr).capacity = new_capacity;
    (*header_ptr).bucket_mask = new_capacity - 1; // Update mask
    (*header_ptr).offset_kind = new_header_layout.offset_kind;
    (*header_ptr).offset_sym = new_header_layout.offset_sym;
    (*header_ptr).offset_left_id = new_header_layout.offset_left_id;
    (*header_ptr).offset_right_id = new_header_layout.offset_right_id;
    (*header_ptr).offset_hash32 = new_header_layout.offset_hash32;
    (*header_ptr).offset_next_idx = new_header_layout.offset_next_idx;
    (*header_ptr).offset_buckets = new_header_layout.offset_buckets;
    (*header_ptr).offset_term_cache = new_header_layout.offset_term_cache;

    // 5. Initialize New Buckets to EMPTY
    let buckets_ptr = buckets_array_ptr(header_ptr);
    let buckets_len = new_capacity as usize; // Now sized to capacity
    // Efficiently set all buckets to EMPTY (0xFFFFFFFF)
    for i in 0..buckets_len {
        *buckets_ptr.add(i) = EMPTY;
    }

    // 6. REHASH: Rebuild Hash Chains
    // This adapts to the new bucket count
    let hash_ptr = hash32_array_ptr(header_ptr);
    let next_ptr = next_idx_array_ptr(header_ptr);
    let new_mask = new_capacity - 1;

    for i in 0..top {
        let h = *hash_ptr.add(i as usize);
        let b = (h & new_mask) as usize;

        let old_head = *buckets_ptr.add(b);
        *next_ptr.add(i as usize) = old_head;
        *buckets_ptr.add(b) = i;
    }

    // 7. Zero-init only the EXTENSIONS of data arrays
    // (We don't need to zero next_idx extension because we only read it if we reached it via valid bucket)
    let added_nodes = (new_capacity - old_capacity) as usize;

    let zero_extension = |offset: u32, element_size: usize| {
        let byte_offset = offset as usize + (old_capacity as usize * element_size);
        let bytes_to_zero = added_nodes * element_size;
        let dst = (header_ptr as *mut u8).add(byte_offset);
        // Safety check
        if header_addr + byte_offset + bytes_to_zero > new_mem_bytes {
            wasm32::unreachable();
        }
        core::ptr::write_bytes(dst, 0, bytes_to_zero);
    };

    zero_extension(new_header_layout.offset_kind, 1);
    zero_extension(new_header_layout.offset_sym, 1);
    zero_extension(new_header_layout.offset_left_id, 4);
    zero_extension(new_header_layout.offset_right_id, 4);
    zero_extension(new_header_layout.offset_hash32, 4);
    // next_idx extension doesn't strictly need zeroing but is good practice
    zero_extension(new_header_layout.offset_next_idx, 4);

    true
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn initArena(initial_capacity: u32) -> u32 {
    if initial_capacity < 1024 || initial_capacity > MAX_CAP || !initial_capacity.is_power_of_two() {
        return 0;
    }

    unsafe {
        // Prevent double initialization in the same instance
        if ARENA_BASE_ADDR != 0 {
            return ARENA_BASE_ADDR;
        }

        let header_ptr = allocate_raw_arena(initial_capacity);
        if header_ptr.is_null() {
            return 1; // Error: OOM
        }

        let header_addr = header_ptr as u32;

        // Final Sanity Check: Is the end of the arena within bounds?
        let mem_bytes = wasm32::memory_size(0) as u32 * WASM_PAGE_SIZE as u32;
        let total_size = calculate_total_arena_size(initial_capacity) as u32;

        if header_addr.checked_add(total_size).map_or(true, |end| end > mem_bytes) {
            return 2; // Error: Allocation logic failed bounds check
        }

        ARENA_BASE_ADDR = header_addr;
        ARENA_MODE = 1; // SAB mode engaged after explicit init

        header_addr
    }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn connectArena(ptr_addr: u32) -> u32 {
    if ptr_addr == 0 {
        return 0; // Error: null pointer
    }

    // 1. Basic alignment check (SabHeader requires 64-byte alignment)
    if ptr_addr % 64 != 0 {
        return 6; // Error: Misaligned address
    }

    let mem_bytes = wasm32::memory_size(0) as u32 * WASM_PAGE_SIZE as u32;

    // 2. Check if header fits in current memory
    if ptr_addr.checked_add(HEADER_SIZE).map_or(true, |end| end > mem_bytes) {
        return 2; // Error: header out of bounds
    }

    let header_ptr = ptr_addr as *mut SabHeader;

    unsafe {
        // 3. MAGIC CHECK (Corruption Detection)
        // Use atomic load to ensure we see the write from the initializing thread
        let magic_ptr = &(*header_ptr).magic as *const u32 as *mut u32;
        let magic = atomic_load_u32(magic_ptr);

        if magic != ARENA_MAGIC {
             return 5; // Error: Invalid Magic / Corrupted Header
        }

        // 4. Validate Capacity
        let capacity_ptr = &(*header_ptr).capacity as *const u32 as *mut u32;
        let capacity = atomic_load_u32(capacity_ptr);

        if capacity < 1024 || capacity > MAX_CAP as u32 || !capacity.is_power_of_two() {
            return 3; // Error: invalid capacity
        }

        // 5. Verify total size fits in memory
        let total_size = calculate_total_arena_size(capacity) as u32;
        if ptr_addr.checked_add(total_size).map_or(true, |end| end > mem_bytes) {
             return 4; // Error: Arena data out of bounds
        }

        // Success - Set Local State
        ARENA_BASE_ADDR = ptr_addr;
        ARENA_MODE = 1; // SAB mode enabled
    }

    1 // Success
}

// ============================================================================
// Debug/Diagnostic Functions
// ============================================================================

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn debugLockState() -> u32 {
    unsafe {
        if ARENA_BASE_ADDR == 0 {
            return 0xffff_ffff; // Arena not initialized
        }
        let header_ptr = ARENA_BASE_ADDR as *mut SabHeader;
        let header = &*header_ptr;
        let lock_ptr = &header.global_lock as *const u32 as *mut u32;
        atomic_load_u32(lock_ptr) // Returns 0 if unlocked, 1 if locked
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn debugLockState() -> u32 {
    0xffff_ffff // Stub for non-WASM targets
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn getArenaMode() -> u32 {
    unsafe { ARENA_MODE }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn debugGetArenaBaseAddr() -> u32 {
    unsafe { ARENA_BASE_ADDR }
}

#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn debugGetArenaBaseAddr() -> u32 {
    0 // Stub for non-WASM targets
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn debugCalculateArenaSize(capacity: u32) -> u32 {
    calculate_total_arena_size(capacity) as u32
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn debugGetMemorySize() -> u32 {
    core::arch::wasm32::memory_size(0) as u32
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn debugGetLockAcquisitionCount() -> u32 {
    unsafe { LOCK_ACQUISITION_COUNT }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn debugGetLockReleaseCount() -> u32 {
    unsafe { LOCK_RELEASE_COUNT }
}

#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn debugGetLockAcquisitionCount() -> u32 {
    0 // Stub for non-WASM targets
}

#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn debugGetLockReleaseCount() -> u32 {
    0 // Stub for non-WASM targets
}

#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn debugCalculateArenaSize(_capacity: u32) -> u32 {
    0 // Stub for non-WASM targets
}

#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn debugGetMemorySize() -> u32 {
    0
}

#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn getArenaMode() -> u32 {
    0 // Stub for non-WASM targets
}

// ============================================================================
// Public API (Must be available on all targets)
// ============================================================================

#[no_mangle]
pub extern "C" fn kindOf(n: u32) -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        let header_ptr = get_arena();
        unsafe {
            if ARENA_MODE == 1 {
                // SAB mode: acquire lock for consistency
                let header = &mut *header_ptr;
                header.lock();
                let result = if n >= header.capacity {
                    0
                } else {
                    *kind_array_ptr(header_ptr).add(n as usize) as u32
                };
                header.unlock();
                result
            } else {
                // Heap mode: no lock needed (single-threaded)
                let header = &*header_ptr;
                if n >= header.capacity {
                    0
                } else {
                    *kind_array_ptr(header_ptr).add(n as usize) as u32
                }
            }
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = n; // Suppress unused variable warning
        0 // Stub for non-WASM targets
    }
}

#[no_mangle]
pub extern "C" fn symOf(n: u32) -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        let header_ptr = get_arena();
        unsafe {
            if ARENA_MODE == 1 {
                // SAB mode: acquire lock for consistency
                let header = &mut *header_ptr;
                header.lock();
                let result = if n >= header.capacity {
                    0
                } else {
                    *sym_array_ptr(header_ptr).add(n as usize) as u32
                };
                header.unlock();
                result
            } else {
                // Heap mode: no lock needed (single-threaded)
                let header = &*header_ptr;
                if n >= header.capacity {
                    0
                } else {
                    *sym_array_ptr(header_ptr).add(n as usize) as u32
                }
            }
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = n; // Suppress unused variable warning
        0 // Stub for non-WASM targets
    }
}

#[no_mangle]
pub extern "C" fn leftOf(n: u32) -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        let header_ptr = get_arena();
        unsafe {
            if ARENA_MODE == 1 {
                // SAB mode: acquire lock for consistency
                let header = &mut *header_ptr;
                header.lock();
                let result = if n >= header.capacity {
                    0
                } else {
                    *left_id_array_ptr(header_ptr).add(n as usize)
                };
                header.unlock();
                result
            } else {
                // Heap mode: no lock needed (single-threaded)
                let header = &*header_ptr;
                if n >= header.capacity {
                    0
                } else {
                    *left_id_array_ptr(header_ptr).add(n as usize)
                }
            }
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = n; // Suppress unused variable warning
        0 // Stub for non-WASM targets
    }
}

#[no_mangle]
pub extern "C" fn rightOf(n: u32) -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        let header_ptr = get_arena();
        unsafe {
            if ARENA_MODE == 1 {
                // SAB mode: acquire lock for consistency
                let header = &mut *header_ptr;
                header.lock();
                let result = if n >= header.capacity {
                    0
                } else {
                    *right_id_array_ptr(header_ptr).add(n as usize)
                };
                header.unlock();
                result
            } else {
                // Heap mode: no lock needed (single-threaded)
                let header = &*header_ptr;
                if n >= header.capacity {
                    0
                } else {
                    *right_id_array_ptr(header_ptr).add(n as usize)
                }
            }
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = n; // Suppress unused variable warning
        0 // Stub for non-WASM targets
    }
}

#[no_mangle]
pub extern "C" fn reset() {
    #[cfg(target_arch = "wasm32")]
    {
        let header_ptr = get_arena();
        let header = unsafe { &mut *header_ptr };
        header.lock();
        header.store_top(0);

        let buckets_ptr = buckets_array_ptr(header_ptr);
        let capacity = header.capacity;
        let buckets_count = capacity as usize; // Dynamic bucket count
        for i in 0..buckets_count {
            unsafe { *buckets_ptr.add(i) = EMPTY; }
        }

        let cache_ptr = term_cache_array_ptr(header_ptr);
        for i in 0..4 {
            unsafe { *cache_ptr.add(i) = EMPTY; }
        }

        header.unlock();
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        // Stub for non-WASM targets
    }
}

#[no_mangle]
pub extern "C" fn allocTerminal(s: u32) -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        let header_ptr = get_arena();
        let header = unsafe { &mut *header_ptr };
        header.lock();

        let mut capacity = header.capacity;
        let mut top = header.load_top();
        if top >= capacity {
            // Try to grow the arena
            if !unsafe { grow_arena(header_ptr) } {
                header.unlock();
                wasm32::unreachable(); // Fatal: capacity exceeded and can't grow
            }
            // After growing, reload capacity and top from updated header
            // We can't use header directly here since grow_arena may have modified it
            // So we reload through the pointer
            capacity = unsafe { (*header_ptr).capacity };
            top = unsafe { (*header_ptr).load_top() };
            if top >= capacity {
                header.unlock();
                wasm32::unreachable(); // Still full after growth (shouldn't happen)
            }
        }

        if s < 4 {
            let cache_ptr = term_cache_array_ptr(header_ptr);
            let cached = unsafe { *cache_ptr.add(s as usize) };
            if cached != EMPTY {
                header.unlock();
                return cached;
            }
        }

        let id = top;
        header.store_top(top + 1);

        unsafe {
            *kind_array_ptr(header_ptr).add(id as usize) = ArenaKind::Terminal as u8;
            *sym_array_ptr(header_ptr).add(id as usize) = s as u8;
            *hash32_array_ptr(header_ptr).add(id as usize) = s;
        }

        if s < 4 {
            let cache_ptr = term_cache_array_ptr(header_ptr);
            unsafe { *cache_ptr.add(s as usize) = id; }
        }

        header.unlock();
        id
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = s; // Suppress unused variable warning
        0 // Stub for non-WASM targets
    }
}

#[no_mangle]
pub extern "C" fn allocCons(l: u32, r: u32) -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        let header_ptr = get_arena();
        let header = unsafe { &*header_ptr }; // Immutable reference for optimistic read

        // --- STEP 1: PRECOMPUTE (Hash) ---
        // We can read mask without lock because it only changes during resize (which takes a lock).
        // Technically racy during resize, but we catch that in the fallback.
        let mask = unsafe { (*header_ptr).bucket_mask };

        // Pointers for READ-ONLY access (safe due to SoA layout)
        let hash_ptr = hash32_array_ptr(header_ptr);
        let hash_l = unsafe { *hash_ptr.add(l as usize) };
        let hash_r = unsafe { *hash_ptr.add(r as usize) };
        let h = mix(hash_l, hash_r);
        let b = (h & mask) as usize;

        // --- STEP 2: OPTIMISTIC READ (No Lock) ---
        // "Verify the original unstable data"
        unsafe {
            let mut current = header.load_bucket_atomic(b);
            let left_ptr = left_id_array_ptr(header_ptr);
            let right_ptr = right_id_array_ptr(header_ptr);

            // Limit the walk to prevent infinite loops if the chain is being resized crazily
            // (though normally resize builds a new arena, so pointers remain valid in old space)
            let mut attempts = 0;

            while current != EMPTY && attempts < 100 {
                // If we read a node ID, the data *must* be valid due to Acquire load above
                let c_left = *left_ptr.add(current as usize);
                let c_right = *right_ptr.add(current as usize);
                // We double check hash to avoid expensive memory lookups on false positives
                let c_hash = *hash_ptr.add(current as usize);

                if c_hash == h && c_left == l && c_right == r {
                    // HIT! We found it without ever locking.
                    return current;
                }

                // Load next pointer atomically
                current = header.load_next_atomic(current as usize);
                attempts += 1;
            }
        }

        // --- STEP 3: ACQUIRE LOCK (The "Commit" Phase) ---
        let header = unsafe { &mut *header_ptr };
        header.lock();

        // --- STEP 4: VERIFY (Double-Checked Locking) ---
        // We must check again. While we were walking above, or waiting for the lock,
        // someone else might have inserted it.

        // Re-read capacity/pointers in case of resize
        let mut capacity = header.capacity;
        let mut top = header.load_top();

        // Growth Check (Standard logic)
        if top >= capacity {
            if !unsafe { grow_arena(header_ptr) } {
                header.unlock();
                wasm32::unreachable();
            }
            capacity = unsafe { (*header_ptr).capacity };
            top = unsafe { (*header_ptr).load_top() };
            if top >= capacity {
                header.unlock();
                wasm32::unreachable();
            }
        }

        // Validate that l and r are within bounds (they should be < top)
        if l >= top || r >= top {
            header.unlock();
            wasm32::unreachable(); // Invalid node IDs
        }

        // Re-calculate bucket (mask might have changed due to resize!)
        let current_mask = header.bucket_mask;
        let b_locked = (h & current_mask) as usize;

        // Standard Locked Search
        let buckets_ptr = buckets_array_ptr(header_ptr);
        let next_ptr = next_idx_array_ptr(header_ptr);
        let left_ptr = left_id_array_ptr(header_ptr);
        let right_ptr = right_id_array_ptr(header_ptr);
        let hash_vals_ptr = hash32_array_ptr(header_ptr);

        let mut current = unsafe { *buckets_ptr.add(b_locked) };
        while current != EMPTY {
            // Validate current is within bounds
            if current >= top {
                header.unlock();
                wasm32::unreachable(); // Invalid node ID in bucket chain
            }
            let c_hash = unsafe { *hash_vals_ptr.add(current as usize) };
            if c_hash == h {
                let c_l = unsafe { *left_ptr.add(current as usize) };
                let c_r = unsafe { *right_ptr.add(current as usize) };
                if c_l == l && c_r == r {
                    header.unlock();
                    return current; // Found it on the second try!
                }
            }
            current = unsafe { *next_ptr.add(current as usize) };
        }

        // --- STEP 5: WRITE (Commit New Data) ---
        let id = top;
        header.store_top(top + 1);

        unsafe {
            *kind_array_ptr(header_ptr).add(id as usize) = ArenaKind::NonTerm as u8;
            *left_ptr.add(id as usize) = l;
            *right_ptr.add(id as usize) = r;
            *hash_vals_ptr.add(id as usize) = h;

            // Link into bucket
            // IMPORTANT: This write makes the node visible to the optimistic readers.
            // We use Release ordering so readers see the data written above
            let old_head = *buckets_ptr.add(b_locked);

            // Store Next: No ordering needed yet, nobody can see 'id' yet
            *next_ptr.add(id as usize) = old_head;

            // Store Bucket Head: RELEASE ordering required so readers see the data written above
            let bucket_atomic = buckets_ptr.add(b_locked) as *mut AtomicU32;
            (&*bucket_atomic).store(id, Ordering::Release);
        }

        header.unlock();
        id
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = l;
        let _ = r;
        0 // Stub for non-WASM targets
    }
}

fn step_internal(expr: u32) -> u32 {
    if kindOf(expr) == ArenaKind::Terminal as u32 {
        return expr;
    }

    let left = leftOf(expr);
    let right = rightOf(expr);

    if kindOf(left) == ArenaKind::Terminal as u32 && symOf(left) == ArenaSym::I as u32 {
        return right;
    }

    if kindOf(left) == ArenaKind::NonTerm as u32 {
        let left_left = leftOf(left);
        if kindOf(left_left) == ArenaKind::Terminal as u32 && symOf(left_left) == ArenaSym::K as u32 {
            return rightOf(left);
        }

        let left_of_left = leftOf(left);
        if kindOf(left_of_left) == ArenaKind::NonTerm as u32 {
            let left_left_left = leftOf(left_of_left);
            if kindOf(left_left_left) == ArenaKind::Terminal as u32
                && symOf(left_left_left) == ArenaSym::S as u32
            {
                let x = rightOf(left_of_left);
                let y = rightOf(left);
                let z = right;
                let xz = allocCons(x, z);
                let yz = allocCons(y, z);
                return allocCons(xz, yz);
            }
        }
    }

    let new_left = step_internal(left);
    if new_left != left {
        return allocCons(new_left, right);
    }

    let new_right = step_internal(right);
    if new_right != right {
        return allocCons(left, new_right);
    }

    expr
}

#[no_mangle]
pub extern "C" fn arenaKernelStep(expr: u32) -> u32 {
    step_internal(expr)
}

#[no_mangle]
pub extern "C" fn reduce(expr: u32, max: u32) -> u32 {
    let mut cur = expr;
    let limit = if max == 0xffff_ffff { u32::MAX } else { max };

    for _ in 0..limit {
        let next = step_internal(cur);
        if next == cur {
            break;
        }
        cur = next;
    }

    cur
}

// ============================================================================
// Tests (WASM only - arena requires WASM memory model)
// ============================================================================
#[cfg(all(test, target_arch = "wasm32"))]
mod tests {
    use super::*;

    fn setup() {
        reset();
    }

    #[test]
    fn test_alloc_terminal() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let k = allocTerminal(ArenaSym::K as u32);
        let i = allocTerminal(ArenaSym::I as u32);

        assert_eq!(kindOf(s), ArenaKind::Terminal as u32);
        assert_eq!(symOf(s), ArenaSym::S as u32);
        assert_eq!(symOf(k), ArenaSym::K as u32);
        assert_eq!(symOf(i), ArenaSym::I as u32);
    }

    #[test]
    fn test_terminal_caching() {
        setup();

        let s1 = allocTerminal(ArenaSym::S as u32);
        let s2 = allocTerminal(ArenaSym::S as u32);

        assert_eq!(s1, s2);
    }

    #[test]
    fn test_alloc_cons() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let k = allocTerminal(ArenaSym::K as u32);
        let cons = allocCons(s, k);

        assert_eq!(kindOf(cons), ArenaKind::NonTerm as u32);
        assert_eq!(leftOf(cons), s);
        assert_eq!(rightOf(cons), k);
    }

    #[test]
    fn test_cons_hash_consing() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let k = allocTerminal(ArenaSym::K as u32);

        let cons1 = allocCons(s, k);
        let cons2 = allocCons(s, k);

        assert_eq!(cons1, cons2);
    }

    #[test]
    fn test_i_combinator() {
        setup();

        let i = allocTerminal(ArenaSym::I as u32);
        let x = allocTerminal(ArenaSym::S as u32);
        let expr = allocCons(i, x);

        let result = arenaKernelStep(expr);

        assert_eq!(result, x);
        assert_eq!(kindOf(result), ArenaKind::Terminal as u32);
        assert_eq!(symOf(result), ArenaSym::S as u32);
    }

    #[test]
    fn test_k_combinator() {
        setup();

        let k = allocTerminal(ArenaSym::K as u32);
        let x = allocTerminal(ArenaSym::S as u32);
        let y = allocTerminal(ArenaSym::I as u32);

        let kx = allocCons(k, x);
        let expr = allocCons(kx, y);

        let result = arenaKernelStep(expr);

        assert_eq!(result, x);
        assert_eq!(kindOf(result), ArenaKind::Terminal as u32);
        assert_eq!(symOf(result), ArenaSym::S as u32);
    }

    #[test]
    fn test_s_combinator() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let x = allocTerminal(ArenaSym::K as u32);
        let y = allocTerminal(ArenaSym::I as u32);
        let z = allocTerminal(10);

        let sx = allocCons(s, x);
        let sxy = allocCons(sx, y);
        let expr = allocCons(sxy, z);

        let result = arenaKernelStep(expr);

        assert_eq!(kindOf(result), ArenaKind::NonTerm as u32);

        let left = leftOf(result);
        let right = rightOf(result);

        assert_eq!(kindOf(left), ArenaKind::NonTerm as u32);
        assert_eq!(leftOf(left), x);
        assert_eq!(rightOf(left), z);

        assert_eq!(kindOf(right), ArenaKind::NonTerm as u32);
        assert_eq!(leftOf(right), y);
        assert_eq!(rightOf(right), z);
    }

    #[test]
    fn test_reduce_i() {
        setup();

        let i = allocTerminal(ArenaSym::I as u32);
        let x = allocTerminal(ArenaSym::S as u32);
        let expr = allocCons(i, x);

        let result = reduce(expr, 100);

        assert_eq!(result, x);
    }

    #[test]
    fn test_reduce_k() {
        setup();

        let k = allocTerminal(ArenaSym::K as u32);
        let x = allocTerminal(ArenaSym::S as u32);
        let y = allocTerminal(ArenaSym::I as u32);

        let kx = allocCons(k, x);
        let expr = allocCons(kx, y);

        let result = reduce(expr, 100);

        assert_eq!(result, x);
    }

    #[test]
    fn test_reduce_nested() {
        setup();

        let i = allocTerminal(ArenaSym::I as u32);
        let k = allocTerminal(ArenaSym::K as u32);
        let x = allocTerminal(ArenaSym::S as u32);

        let kx = allocCons(k, x);
        let expr = allocCons(i, kx);

        let result = reduce(expr, 100);

        assert_eq!(result, kx);
        assert_eq!(leftOf(result), k);
        assert_eq!(rightOf(result), x);
    }

    #[test]
    fn test_reset() {
        setup();

        let s1 = allocTerminal(ArenaSym::S as u32);
        let k1 = allocTerminal(ArenaSym::K as u32);
        let _cons1 = allocCons(s1, k1);

        reset();

        let s2 = allocTerminal(ArenaSym::S as u32);
        let k2 = allocTerminal(ArenaSym::K as u32);

        assert_eq!(s2, 0);
        assert_eq!(k2, 1);
    }

    #[test]
    fn test_terminal_accessors() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let k = allocTerminal(ArenaSym::K as u32);
        let i = allocTerminal(ArenaSym::I as u32);

        assert_eq!(kindOf(s), ArenaKind::Terminal as u32);
        assert_eq!(kindOf(k), ArenaKind::Terminal as u32);
        assert_eq!(kindOf(i), ArenaKind::Terminal as u32);

        assert_eq!(symOf(s), ArenaSym::S as u32);
        assert_eq!(symOf(k), ArenaSym::K as u32);
        assert_eq!(symOf(i), ArenaSym::I as u32);
    }

    #[test]
    fn test_cons_accessors() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let k = allocTerminal(ArenaSym::K as u32);
        let i = allocTerminal(ArenaSym::I as u32);

        let sk = allocCons(s, k);
        let ski = allocCons(sk, i);

        assert_eq!(kindOf(ski), ArenaKind::NonTerm as u32);
        assert_eq!(leftOf(ski), sk);
        assert_eq!(rightOf(ski), i);
        assert_eq!(leftOf(leftOf(ski)), s);
        assert_eq!(rightOf(leftOf(ski)), k);
    }
}
