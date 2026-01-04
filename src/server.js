/**
 * The core server that runs on a Cloudflare worker.
 */
import { AutoRouter } from 'itty-router';
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
  InteractionResponseFlags,
} from 'discord-interactions';
import {
  SESSION_START_COMMAND,
  SESSION_END_COMMAND,
  VOTE_START_COMMAND,
  VOTE_END_COMMAND,
  VOTE_NEXT_COMMAND
} from './commands.js';

class JsonResponse extends Response {
  constructor(body, init) {
    const jsonBody = JSON.stringify(body);
    init = init || {
      headers: { 'content-type': 'application/json;charset=UTF-8' },
    };
    super(jsonBody, init);
  }
}

const router = AutoRouter();

// --- HELPER FUNCTIONS ---

// Extract ID from YouTube URL
function getVideoId(url) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[2].length === 11 ? match[2] : null;
}

function getPlaylistId(url) {
  const regExp = /[?&]list=([^#&]+)/;
  const match = url.match(regExp);
  return match && match[1] ? match[1] : null;
}

// Fetch Title from YouTube API
async function getVideoTitle(videoId, apiKey) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  return data.items?.[0]?.snippet?.title || 'Unknown Song';
}

async function getPlaylistTitle(playlistId, apiKey) {
  const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  return data.items?.[0]?.snippet?.title || 'Unknown Playlist';
}

// Fetch items from a YouTube Playlist (Max 50 for this version)
async function getPlaylistItems(playlistId, apiKey) {
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  
  if (!data.items) return [];

  return data.items.map((item) => ({
    title: item.snippet.title,
    id: item.snippet.resourceId.videoId,
    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url
  }));
}

// Check if user is the Manager
function isManager(interaction, env) {
  return interaction.member.user.id === env.MANAGER_USER_ID;
}

// --- ROUTES ---

router.get('/', (request, env) => {
  return new Response(`👋 ${env.DISCORD_APPLICATION_ID}`);
});

router.post('/', async (request, env) => {
  const { isValid, interaction } = await server.verifyDiscordRequest(
    request,
    env,
  );
  if (!isValid || !interaction) {
    return new Response('Bad request signature.', { status: 401 });
  }

  // 1. PING (Handshake)
  if (interaction.type === InteractionType.PING) {
    return new JsonResponse({ type: InteractionResponseType.PONG });
  }

  // 2. SLASH COMMANDS
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    // Security: Reject if not the manager
    if (!isManager(interaction, env)) {
      return new JsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: '관리자만 조작할 수 있습니다.',
          flags: InteractionResponseFlags.EPHEMERAL,
        },
      });
    }

    switch (interaction.data.name.toLowerCase()) {
      case SESSION_START_COMMAND.name: {
        const session_active = await env.DB.get('SESSION_ACTIVE');
        if (session_active === 'true') {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '**이미 시작된 세션이 있어요.**',
              flags: InteractionResponseFlags.EPHEMERAL,
            },
          });
        }
        
        let initialQueue = [];
        let startMessage = '**새로운 세션이 시작되었습니다!**';

        const playlistUrlOption = interaction.data.options?.find(
          (o) => o.name === 'playlist_url',
        );

        if (playlistUrlOption) {
          const pid = getPlaylistId(playlistUrlOption.value);

          // Error A: URL format is wrong
          if (!pid) {
            return new JsonResponse({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content:
                  '**잘못된 URL입니다.** 유효한 유튜브 플레이리스트 링크를 입력해주세요.',
                flags: InteractionResponseFlags.EPHEMERAL,
              },
            });
          }

          // Error B: API cannot find playlist or it's empty
          const items = await getPlaylistItems(pid, env.YOUTUBE_API_KEY);
          if (items.length === 0) {
            return new JsonResponse({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content:
                  '**플레이리스트를 불러올 수 없습니다.**\n리스트가 비공개이거나 비어있는 건 아닌지 확인해주세요.',
                flags: InteractionResponseFlags.EPHEMERAL,
              },
            });
          }

          initialQueue = items;
          startMessage = `**새로운 세션이 시작되었습니다!**\n**플레이리스트 로딩 완료:** ${items.length}곡 대기 중`;
        }

        // 3. EXECUTION: Only runs if validation passed
        await env.DB.put('SESSION_ACTIVE', 'true');
        await env.DB.delete('CURRENT_SONG');
        await env.DB.delete('VOTED_USERS');
        await env.DB.delete('HISTORY');

        // Save the valid queue (or empty array if manual)
        await env.DB.put('QUEUE', JSON.stringify(initialQueue));

        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: startMessage },
        });
      }

      case VOTE_START_COMMAND.name: {
        const session_active = await env.DB.get('SESSION_ACTIVE');
        if (session_active === 'false') {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '**현재 진행중인 세션이 없어요.**',
              flags: InteractionResponseFlags.EPHEMERAL,
            },
          });
        }

        const songDataStr = await env.DB.get('CURRENT_SONG');
        if (songDataStr) {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '이미 재생 중인 음악이 있어요!',
              flags: InteractionResponseFlags.EPHEMERAL,
            },
          });
        }

        const url = interaction.data.options.find(
          (o) => o.name === 'url',
        ).value;
        const vidId = getVideoId(url);

        if (!vidId) {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '유튜브 동영상 정보를 불러오는데 실패했어요.',
              flags: InteractionResponseFlags.EPHEMERAL,
            },
          });
        }

        // Defer response (fetching from YouTube might take >3s)
        // Note: For simplicity in this example, we assume it's fast.
        // If it times out, we'd need a separate "DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE" flow.
        const title = await getVideoTitle(vidId, env.YOUTUBE_API_KEY);

        // Save State
        await env.DB.put(
          'CURRENT_SONG',
          JSON.stringify({ title, id: vidId, votes: 0 }),
        );
        await env.DB.put('VOTED_USERS', JSON.stringify([]));

        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `🎶 **지금 재생 중**`,
            embeds: [
              {
                title: title,
                url: url,
                image: {
                  url: `https://img.youtube.com/vi/${vidId}/mqdefault.jpg`,
                },
                color: 0xff0000,
              },
            ],
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 1, // Primary Button
                    label: 'また聞きたい!',
                    custom_id: `vote_${vidId}`,
                  },
                ],
              },
            ],
          },
        });
      }

      case VOTE_NEXT_COMMAND.name: {
        // 1. Check Session
        const session_active = await env.DB.get('SESSION_ACTIVE');
        if (session_active !== 'true') {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '**현재 진행중인 세션이 없어요.**',
              flags: InteractionResponseFlags.EPHEMERAL,
            },
          });
        }

        // 2. Check if something is already playing
        const currentSong = await env.DB.get('CURRENT_SONG');
        if (currentSong) {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '이미 재생 중인 음악이 있어요!',
              flags: InteractionResponseFlags.EPHEMERAL,
            },
          });
        }

        // 3. Load Queue
        const queueStr = await env.DB.get('QUEUE');
        let queue = queueStr ? JSON.parse(queueStr) : [];

        if (queue.length === 0) {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content:
                '**대기열에 남은 곡이 없습니다.** `/vote-start <url>`을 사용하여 직접 추가해주세요.',
              flags: InteractionResponseFlags.EPHEMERAL,
            },
          });
        }

        // 4. Pop the next song
        const nextSong = queue.shift(); // Removes the first item
        const remaining = queue.length;

        // 5. Save updates to DB
        await env.DB.put('QUEUE', JSON.stringify(queue)); // Save smaller queue

        // Save as current song (Reset votes)
        await env.DB.put(
          'CURRENT_SONG',
          JSON.stringify({
            title: nextSong.title,
            id: nextSong.id,
            votes: 0,
          }),
        );
        await env.DB.put('VOTED_USERS', JSON.stringify([]));

        // 6. Response (Same UI as vote-start)
        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `🎶 **다음 곡 재생** (남은 곡: ${remaining}개)`,
            embeds: [
              {
                title: nextSong.title,
                url: `https://www.youtube.com/watch?v=${nextSong.id}`,
                image: {
                  url:
                    nextSong.thumbnail ||
                    `https://img.youtube.com/vi/${nextSong.id}/mqdefault.jpg`,
                },
                color: 0xff0000,
              },
            ],
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 1, // Primary Button
                    label: 'また聞きたい!',
                    custom_id: `vote_${nextSong.id}`,
                  },
                ],
              },
            ],
          },
        });
      }

      case VOTE_END_COMMAND.name: {
        const songDataStr = await env.DB.get('CURRENT_SONG');
        if (!songDataStr) {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '지금 재생 중인 음악이 없어요.',
              flags: InteractionResponseFlags.EPHEMERAL,
            },
          });
        }

        const songData = JSON.parse(songDataStr);
        const votersStr = await env.DB.get('VOTED_USERS');
        const voters = votersStr ? JSON.parse(votersStr) : [];
        const currentSessionVotes = voters.length;

        // Save to History
        const historyStr = await env.DB.get('HISTORY');
        const history = historyStr ? JSON.parse(historyStr) : {};
        if (history[songData.id]) {
          history[songData.id].votes += currentSessionVotes;
        } else {
          history[songData.id] = {
            title: songData.title,
            votes: currentSessionVotes,
          };
        }
        await env.DB.put('HISTORY', JSON.stringify(history));

        await env.DB.put('CURRENT_SONG', '');

        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `**투표 종료!** (${songData.title})\n**투표 결과**: ${currentSessionVotes}표`,
          },
        });
      }

      case SESSION_END_COMMAND.name: {
        const session_active = await env.DB.get('SESSION_ACTIVE');
        if (session_active === 'false') {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '**현재 활성화된 세션이 없어요.**',
              flags: InteractionResponseFlags.EPHEMERAL,
            },
          });
        }

        const songDataStr = await env.DB.get('CURRENT_SONG');
        if (songDataStr) {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: '아직 재생 중인 음악이 있어요!',
              flags: InteractionResponseFlags.EPHEMERAL,
            },
          });
        }

        await env.DB.put('SESSION_ACTIVE', 'false');

        const historyStr = await env.DB.get('HISTORY');
        const history = historyStr ? JSON.parse(historyStr) : {};

        let summaryLines = [];

        // Sort by votes (Highest first)
        const sortedSongs = Object.values(history).sort(
          (a, b) => b.votes - a.votes,
        );

        for (const song of sortedSongs) {
          summaryLines.push(`• **${song.title}**: ${song.votes} 표`);
        }

        const summary =
          summaryLines.length > 0 ? summaryLines.join('\n') : 'No songs saved.';

        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `**세션이 종료되었습니다.**\n\n**최종 결과:**\n${summary}`,
          },
        });
      }

      default:
        return new JsonResponse({ error: 'Unknown Type' }, { status: 400 });
    }
  }

  // 3. BUTTON INTERACTIONS (The Voting Logic)
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data.custom_id;

    // Check if this is a vote button
    if (customId.startsWith('vote_')) {
      // 1. Check if Session is Active
      const active = await env.DB.get('SESSION_ACTIVE');
      if (active !== 'true') {
        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '세션이 이미 종료되었습니다.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      // 2. LOGIC LOCK: Check if this button belongs to the CURRENT song
      // We extract the ID from the button (vote_XYZ) and compare it to DB
      const buttonVidId = customId.replace('vote_', '');
      const currentSongStr = await env.DB.get('CURRENT_SONG');
      const currentSong = currentSongStr ? JSON.parse(currentSongStr) : null;

      if (!currentSong || currentSong.id !== buttonVidId) {
        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '투표가 이미 종료되었습니다.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      // 3. TOGGLE VOTE LOGIC
      const userId = interaction.member.user.id;
      const votersStr = await env.DB.get('VOTED_USERS');
      let voters = votersStr ? JSON.parse(votersStr) : [];

      let message = '';

      if (voters.includes(userId)) {
        // REMOVE VOTE (Cancel)
        voters = voters.filter((id) => id !== userId);
        message = '투표가 취소되었습니다.';
      } else {
        // ADD VOTE
        voters.push(userId);
        message = '**투표 완료!**';
      }

      await env.DB.put('VOTED_USERS', JSON.stringify(voters));

      // 4. RESPONSE
      // We do NOT update the message button (keeps it static/private).
      // We just reply with a hidden message to the user.
      return new JsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: message,
          flags: InteractionResponseFlags.EPHEMERAL,
        },
      });
    }
  }

  return new JsonResponse({ error: '알 수 없는 오류' }, { status: 400 });
});

router.all('*', () => new Response('Not Found.', { status: 404 }));

// --- VERIFICATION LOGIC ---

async function verifyDiscordRequest(request, env) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  const isValidRequest =
    signature &&
    timestamp &&
    (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
  if (!isValidRequest) {
    return { isValid: false };
  }
  return { interaction: JSON.parse(body), isValid: true };
}

const server = {
  verifyDiscordRequest,
  fetch: router.fetch,
};

export default server;
