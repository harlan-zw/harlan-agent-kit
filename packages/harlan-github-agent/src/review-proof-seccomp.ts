import { Buffer } from 'node:buffer'

/** Linux classic BPF. Reject network sockets and process creation while preserving V8 threads. */
export function reviewProofSeccomp(architecture: string): Buffer {
  if (architecture !== 'x64')
    throw new Error('The Review proof requires Linux x64 seccomp support.')
  const instructions: { code: number, yes: number, no: number, value: number }[] = []
  const statement = (code: number, value: number) => instructions.push({ code, yes: 0, no: 0, value })
  const jump = (code: number, value: number, yes: number, no: number) => instructions.push({ code, yes, no, value })
  const deny = 0x00050001 // SECCOMP_RET_ERRNO | EPERM
  statement(0x20, 4) // Load seccomp_data.arch.
  jump(0x15, 0xC000003E, 1, 0) // AUDIT_ARCH_X86_64.
  statement(0x06, 0x80000000) // SECCOMP_RET_KILL_PROCESS on another ABI.
  statement(0x20, 0) // Load syscall number.
  jump(0x45, 0x40000000, 0, 1) // Refuse the x32 ABI.
  statement(0x06, deny)
  for (const syscall of [41, 53, 57, 58, 109, 112]) { // socket, socketpair, fork, vfork, setpgid, setsid.
    jump(0x15, syscall, 0, 1)
    statement(0x06, deny)
  }
  jump(0x15, 435, 0, 1) // clone3.
  statement(0x06, 0x00050026) // ENOSYS makes glibc use inspectable clone flags.
  jump(0x15, 56, 0, 7) // clone.
  statement(0x20, 16) // Load clone flags from args[0].
  jump(0x45, 0x4000, 0, 1) // CLONE_VFORK cannot create a child process.
  statement(0x06, deny)
  jump(0x45, 0x100, 1, 0) // A thread requires CLONE_VM.
  statement(0x06, deny)
  jump(0x45, 0x10000, 1, 0) // CLONE_THREAD keeps the same process.
  statement(0x06, deny)
  statement(0x06, 0x7FFF0000) // SECCOMP_RET_ALLOW.
  const bytes = Buffer.alloc(instructions.length * 8)
  instructions.forEach((instruction, index) => {
    bytes.writeUInt16LE(instruction.code, index * 8)
    bytes.writeUInt8(instruction.yes, index * 8 + 2)
    bytes.writeUInt8(instruction.no, index * 8 + 3)
    bytes.writeUInt32LE(instruction.value, index * 8 + 4)
  })
  return bytes
}
