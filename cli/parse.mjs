const usage = 'cordisx-chatroom [--binding <path>] send --operation <id> --text <text> [--room <id>]';

export function parseChatroomArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: usage };
  const values = new Map();
  let command;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === 'send' && command === undefined) {
      command = arg;
      continue;
    }
    if (!['--binding', '--operation', '--text', '--room'].includes(arg) || values.has(arg)) {
      throw new Error(`Invalid or duplicate argument. Usage: ${usage}`);
    }
    if (index + 1 >= args.length) throw new Error(`Missing argument value. Usage: ${usage}`);
    values.set(arg, args[++index]);
  }
  if (
    command !== 'send' || !values.get('--binding')
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(values.get('--operation') ?? '')
    || !values.get('--text')?.trim() || values.get('--text').length > 16000
    || values.has('--room') && !values.get('--room')
  ) throw new Error(`Invalid input. Usage: ${usage}`);
  return {
    bindingPath: values.get('--binding'),
    input: {
      operationId: values.get('--operation'),
      text: values.get('--text'),
      ...(values.has('--room') ? { roomId: values.get('--room') } : {}),
    },
  };
}
