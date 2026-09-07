const usage =
  'cordisx-chatroom --binding <path> send|delegate|query --operation <id> [--text <text>] [--to <member>] [--cwd <absolute-path>] [--project <id>] [--room <id>]';

export function parseChatroomArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: usage };
  const values = new Map();
  let command;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (['send', 'delegate', 'query'].includes(arg) && command === undefined) {
      command = arg;
      continue;
    }
    if (
      !['--binding', '--operation', '--text', '--room', '--to', '--cwd', '--project'].includes(arg) || values.has(arg)
    ) {
      throw new Error(`Invalid or duplicate argument. Usage: ${usage}`);
    }
    if (index + 1 >= args.length) throw new Error(`Missing argument value. Usage: ${usage}`);
    values.set(arg, args[++index]);
  }
  const common = ['--binding', '--operation', '--room'];
  const allowed = command === 'query' ? common : command === 'delegate'
    ? [...common, '--text', '--to', '--cwd', '--project']
    : [...common, '--text'];
  if (
    !command || !values.get('--binding') || [...values.keys()].some(key => !allowed.includes(key))
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values.get('--operation') ?? '')
    || command !== 'query' && (!values.get('--text')?.trim() || values.get('--text').length > 16000)
    || command === 'delegate' && !values.get('--to')?.trim()
    || ['--room', '--project'].some(key => values.has(key) && !values.get(key)?.trim())
    || values.has('--cwd') && (!values.get('--cwd').startsWith('/') || values.get('--cwd').includes('\0'))
  ) throw new Error(`Invalid input. Usage: ${usage}`);
  return {
    bindingPath: values.get('--binding'),
    input: {
      ...(command === 'send' ? {} : { action: command }),
      operationId: values.get('--operation'),
      ...(command === 'query' ? {} : { text: values.get('--text') }),
      ...(values.has('--to') ? { to: values.get('--to') } : {}),
      ...(values.has('--room') ? { roomId: values.get('--room') } : {}),
      ...(values.has('--cwd') ? { cwd: values.get('--cwd') } : {}),
      ...(values.has('--project') ? { projectId: values.get('--project') } : {}),
    },
  };
}
