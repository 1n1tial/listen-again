/**
 * Share command metadata from a common spot to be used for both runtime
 * and registration.
 */

export const SESSION_START_COMMAND = {
  name: 'session-start',
  description: 'Start a new listening session (Clears previous history)',
  options: [
    {
      name: 'playlist_url',
      description: 'Optional: YouTube Playlist URL to load',
      type: 3, // STRING
      required: false, // optional
    },
  ],
};

export const SESSION_END_COMMAND = {
  name: 'session-end',
  description: 'End the session and show the final recap',
};

export const VOTE_START_COMMAND = {
  name: 'vote-start',
  description: 'Start voting for a YouTube video',
  options: [
    {
      name: 'url',
      description: 'The YouTube URL to play',
      type: 3, // STRING
      required: true,
    },
  ],
};

export const VOTE_NEXT_COMMAND = {
  name: 'vote-next',
  description: 'Play the next song in the loaded playlist',
};

export const VOTE_END_COMMAND = {
  name: 'vote-end',
  description: 'Stop voting for the current song and save results',
};

export const ENTER_COMMAND = {
  name: 'enter',
  description: 'Join the current session',
};

export const EXIT_COMMAND = {
  name: 'exit',
  description: 'Leave the current session',
};

export const KICK_COMMAND = {
  name: 'kick',
  description: 'Kick a user from the current session (Manager only)',
  options: [
    {
      name: 'user',
      description: 'The user to kick from the session',
      type: 6, // USER
      required: true,
    },
  ],
};

export const PARTICIPANTS_COMMAND = {
  name: 'participants',
  description: 'View list of current session participants (Manager only)',
};
