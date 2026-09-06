/**
 * Materializes an explicit Playground team into the profile-scoped config
 * that Host precedence passes to Chatroom apply(). It never changes defaults.
 */
export function materializePlaygroundTeamProfile(plugin, profileId = 'playground') {
  if (plugin?.id !== 'chatroom' || plugin.config?.team === undefined) {
    throw new Error('Playground Chatroom fixture requires one explicit top-level config.team.');
  }
  const scoped = plugin.profiles?.[profileId] ?? {};
  return {
    ...plugin,
    profiles: {
      ...(plugin.profiles ?? {}),
      [profileId]: {
        ...scoped,
        config: {
          ...plugin.config,
          ...(scoped.config ?? {}),
          team: plugin.config.team,
        },
      },
    },
  };
}
