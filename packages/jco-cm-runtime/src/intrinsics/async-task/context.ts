import type { ThreadLookupContext, AsyncTaskModule, AsyncStringRealloc } from '../../runtime.js';
import { typeCheckValidI32 } from './helpers.js';
import { debugLog } from '../core/debug.js';
import { getOrCreateAsyncState } from '../component.js';

/** Implements `canon context.set`. */
export function contextSet(
    _context: ThreadLookupContext,
    ctx: {
        componentIdx?: number;
        slot: number;
    },
    value: number,
): ReturnType<AsyncTaskModule['contextSet']> {
    const { slot } = ctx;
    if (slot === undefined) {
        throw new TypeError('missing slot');
    }
    if (!typeCheckValidI32(value)) {
        throw new Error('invalid value for context set (not valid i32)');
    }
    // FACT adapters and post-return use the executing frame when the component's thread has exited.
    const active = _context.registers.storage;
    const storage =
        (ctx.componentIdx === undefined ? undefined : active?.[ctx.componentIdx]?.slots) ?? active?.current?.slots;
    if (!storage) {
        throw new Error(`missing active context storage for component idx [${ctx.componentIdx}]`);
    }
    debugLog('[contextSet()] args', {
        slot,
        value,
        storage,
        componentIdx: ctx.componentIdx,
    });
    if (slot < 0 || slot >= storage.length) {
        throw new Error('invalid slot for current thread');
    }
    storage[slot] = value;
}

/** Implements `canon context.get`. */
export function contextGet(
    _context: ThreadLookupContext,
    ctx: {
        componentIdx?: number;
        slot: number;
    },
): ReturnType<AsyncTaskModule['contextGet']> {
    const { slot } = ctx;
    if (slot === undefined) {
        throw new TypeError('missing slot');
    }
    // FACT adapters and post-return use the executing frame when the component's thread has exited.
    const active = _context.registers.storage;
    const storage =
        (ctx.componentIdx === undefined ? undefined : active?.[ctx.componentIdx]?.slots) ?? active?.current?.slots;
    if (!storage) {
        throw new Error(`missing active context storage for component idx [${ctx.componentIdx}]`);
    }
    debugLog('[contextGet()] args', {
        slot,
        storage,
        componentIdx: ctx.componentIdx,
    });
    if (slot < 0 || slot >= storage.length) {
        throw new Error('invalid slot for current thread');
    }
    return storage[slot];
}

/**
 * Run each host call to a guest realloc with fresh slots in the ordinary active storage registers.
 *
 * Guest execution must finish synchronously: mayLeave forbids calls that could suspend it.
 * A JSPI wrapper can still return a promise, but slot restoration must not wait for its reactions.
 *
 * @param context - component state and active execution registers
 * @param componentIdx - component instance owning the allocator
 * @param realloc - guest allocator, possibly wrapped by WebAssembly.promising
 * @returns an allocator with the same four-argument signature
 */
export function isolateRealloc(
    context: ThreadLookupContext,
    componentIdx: number,
    realloc: AsyncStringRealloc,
): AsyncStringRealloc {
    return (oldPtr, oldSize, alignment, newSize) => {
        const state = getOrCreateAsyncState(context.lookup, componentIdx);
        const storage = (context.registers.storage ??= {});
        const previousStorage = storage[componentIdx];
        const previousCurrentStorage = storage.current;
        const previousMayLeave = state.mayLeave;

        storage.current = storage[componentIdx] = { slots: [0, 0] };
        state.mayLeave = false;
        try {
            return realloc(oldPtr, oldSize, alignment, newSize);
        } finally {
            state.mayLeave = previousMayLeave;
            storage[componentIdx] = previousStorage;
            storage.current = previousCurrentStorage;
        }
    };
}
