// SusMeter CS: оценка подозрительности аккаунта по открытым данным Steam.
// Переменные окружения (Netlify > Site settings > Environment variables):
//   STEAM_API_KEY      (обязательно) https://steamcommunity.com/dev/apikey
//   ANTHROPIC_API_KEY  (по желанию) для объяснения от нейросети; без него текст соберётся по шаблону

const STEAM = "https://api.steampowered.com";
const CS2 = 730;

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

async function steam(path, params) {
  const url = `${STEAM}/${path}?key=${process.env.STEAM_API_KEY}&${new URLSearchParams(params)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Steam ${res.status}`);
  return res.json();
}

async function resolveId(q) {
  q = q.trim();
  let m = q.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (m) return m[1];
  if (/^\d{17}$/.test(q)) return q;
  m = q.match(/steamcommunity\.com\/id\/([^/?#]+)/);
  const vanity = m ? m[1] : q;
  const r = await steam("ISteamUser/ResolveVanityURL/v1/", { vanityurl: vanity });
  return r.response.success === 1 ? r.response.steamid : null;
}

function score(d) {
  const f = []; // { kind: "risk" | "trust", points, label }
  const add = (kind, points, label) => f.push({ kind, points, label });

  if (d.bans.VACBanned || d.bans.NumberOfGameBans > 0) {
    add("risk", 30, "На аккаунте есть VAC- или игровой бан");
  }
  if (d.ageDays !== null) {
    if (d.ageDays < 30) add("risk", 15, `Аккаунту меньше месяца (${d.ageDays} дн.)`);
    else if (d.ageDays > 365 * 3) add("trust", -10, `Аккаунту больше 3 лет (${Math.floor(d.ageDays / 365)} г.)`);
  }
  if (d.csHours !== null) {
    if (d.csHours < 100 && d.kd >= 1.8) add("risk", 20, `Мало часов (${d.csHours}), но K/D ${d.kd}`);
    if (d.csHours > 1000 && !d.bans.VACBanned) add("trust", -10, `Много часов в КС (${d.csHours}) без банов`);
  }
  if (d.hs >= 70) add("risk", 10, `Очень высокий HS%: ${d.hs}%`);
  else if (d.hs >= 60) add("risk", 5, `Повышенный HS%: ${d.hs}%`);
  if (d.friendsChecked > 0 && d.friendsBanned >= 2) {
    add("risk", 10, `У ${d.friendsBanned} из ${d.friendsChecked} друзей есть баны`);
  }
  if (d.level !== null && d.level >= 10) add("trust", -5, `Уровень Steam ${d.level}`);
  if (!d.isPublic) add("risk", 5, "Профиль закрыт, данных для оценки меньше");

  const total = Math.max(0, Math.min(100, f.reduce((s, x) => s + x.points, 0)));
  const level = total < 25 ? "low" : total < 55 ? "medium" : "high";
  return { total, level, factors: f };
}

async function explain(d, result) {
  const lines = result.factors.map((x) => `${x.points > 0 ? "+" : ""}${x.points}: ${x.label}`).join("\n");
  const fallback =
    result.factors.length === 0
      ? "Явных признаков риска не найдено. Это оценка по открытым данным, а не доказательство."
      : `Оценка ${result.total}/100 собрана из признаков:\n${lines}\nЭто оценка по косвенным признакам, а не доказательство читерства.`;

  if (!process.env.ANTHROPIC_API_KEY) return fallback;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system:
          "Ты помощник, который объясняет оценку подозрительности аккаунта в CS2. Пиши по-русски, простым языком, 3-4 предложения. Не утверждай, что человек читер: это лишь косвенные признаки. Отдельно упомяни, что выглядит нормально. Опирайся только на данные ниже.",
        messages: [{ role: "user", content: `Итог: ${result.total}/100 (${result.level}).\nПризнаки:\n${lines || "нет"}` }],
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text || fallback;
  } catch {
    return fallback;
  }
}

exports.handler = async (event) => {
  try {
    if (!process.env.STEAM_API_KEY) return json(500, { error: "Не задан STEAM_API_KEY в настройках Netlify" });
    const p = event.queryStringParameters || {};
    if (!p.q) return json(400, { error: "Вставь ссылку на Steam-профиль или SteamID" });

    const id = await resolveId(p.q);
    if (!id) return json(404, { error: "Профиль не найден. Проверь ссылку." });

    const [sum, bans, games, lvl, friends] = await Promise.all([
      steam("ISteamUser/GetPlayerSummaries/v2/", { steamids: id }),
      steam("ISteamUser/GetPlayerBans/v1/", { steamids: id }),
      steam("IPlayerService/GetOwnedGames/v1/", { steamid: id, include_played_free_games: 1, "appids_filter[0]": CS2 }).catch(() => null),
      steam("IPlayerService/GetSteamLevel/v1/", { steamid: id }).catch(() => null),
      steam("ISteamUser/GetFriendList/v1/", { steamid: id, relationship: "friend" }).catch(() => null),
    ]);

    const player = sum.response.players[0];
    if (!player) return json(404, { error: "Профиль не найден." });
    const isPublic = player.communityvisibilitystate === 3;

    // баны друзей (до 100 человек)
    let friendsChecked = 0, friendsBanned = 0;
    const ids = (friends?.friendslist?.friends || []).slice(0, 100).map((x) => x.steamid);
    if (ids.length) {
      const fb = await steam("ISteamUser/GetPlayerBans/v1/", { steamids: ids.join(",") });
      friendsChecked = fb.players.length;
      friendsBanned = fb.players.filter((x) => x.VACBanned || x.NumberOfGameBans > 0).length;
    }

    const csGame = games?.response?.games?.[0];
    const d = {
      isPublic,
      bans: bans.players[0],
      ageDays: player.timecreated ? Math.floor((Date.now() / 1000 - player.timecreated) / 86400) : null,
      csHours: csGame ? Math.round(csGame.playtime_forever / 60) : null,
      level: lvl?.response?.player_level ?? null,
      friendsChecked,
      friendsBanned,
      // ручной ввод из csstats/Leetify (необязательно)
      hs: Number(p.hs) || 0,
      kd: Number(p.kd) || 0,
    };

    const result = score(d);
    const explanation = await explain(d, result);

    return json(200, {
      profile: { name: player.personaname, avatar: player.avatarfull, url: player.profileurl },
      ...result,
      explanation,
    });
  } catch (e) {
    return json(500, { error: "Что-то пошло не так: " + e.message });
  }
};
