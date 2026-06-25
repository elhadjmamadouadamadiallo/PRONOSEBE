import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://api.football-data.org/v4";
const SEUIL_NE_PERD_PAS = 50; // publié en double chance à partir d'ici
const SEUIL_VICTOIRE = 60;    // publié en « gagne » à partir d'ici

Deno.serve(async () => {
  const fdHeaders = { "X-Auth-Token": Deno.env.get("FOOTBALL_DATA_KEY")! };
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const auj = new Date().toISOString().slice(0, 10);
  const fin = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10); // fenêtre de 6 jours

  // Requête 1 : matchs du Mondial sur la fenêtre de 6 jours
  const mj = await (await fetch(
    `${API}/competitions/WC/matches?dateFrom=${auj}&dateTo=${fin}`,
    { headers: fdHeaders },
  )).json();

  // Requête 2 : classements des 12 groupes
  const cl = await (await fetch(
    `${API}/competitions/WC/standings`,
    { headers: fdHeaders },
  )).json();

  // Index des stats par équipe
  const stats = new Map<number, any>();
  for (const g of cl.standings ?? [])
    for (const t of g.table ?? []) stats.set(t.team.id, t);

  // Métriques par match joué
  const ppm = (t: any) => t.points / t.playedGames;
  const dgm = (t: any) => t.goalDifference / t.playedGames;

  // FORME DU COLLECTIF, normalisée sur [0, 1].
  // On lit la séquence récente fournie par l'API (champ `form` : ex. "W,W,D").
  // Repli automatique sur les points par match si l'API ne renvoie pas ce champ
  // pour le Mondial (cas fréquent en phase de groupes : peu de matchs joués).
  const forme = (t: any): number => {
    const lettres = typeof t.form === "string" ? (t.form.match(/[WDL]/g) ?? []) : [];
    if (lettres.length) {
      const pts = lettres.reduce(
        (s: number, r: string) => s + (r === "W" ? 3 : r === "D" ? 1 : 0), 0,
      );
      return pts / (lettres.length * 3);
    }
    return ppm(t) / 3; // repli : la forme = le parcours du tournoi
  };

  // Force globale = 50 % forme + 50 % niveau (sert à désigner le favori).
  const force = (t: any) => 0.5 * forme(t) + 0.5 * (ppm(t) / 3);

  let analyses = 0, publies = 0, exclus = 0;

  for (const m of mj.matches ?? []) {
    // Phases de groupes uniquement
    if (m.stage !== "GROUP_STAGE") continue;

    // RÈGLE ESSENTIELLE : ne pronostiquer que les matchs À VENIR.
    // On ignore tout match en cours, terminé, suspendu ou reporté.
    if (m.status !== "SCHEDULED" && m.status !== "TIMED") continue;

    const dom = stats.get(m.homeTeam.id);
    const ext = stats.get(m.awayTeam.id);
    if (!dom || !ext) continue;

    const base = {
      fixture_id: m.id,
      date_match: m.utcDate,
      championnat: "Coupe du Monde 2026",
      championnat_id: 1,
      equipe_dom: m.homeTeam.name,
      equipe_ext: m.awayTeam.name,
    };

    // ÉLIMINATOIRE : aucune donnée de tournoi disponible
    if (dom.playedGames === 0 || ext.playedGames === 0) {
      await supabase.from("matchs_analyses").upsert({
        ...base, statut: "exclu",
        motif_exclusion: "1re journee : aucune donnee de tournoi",
      }, { onConflict: "fixture_id" });
      exclus++;
      continue;
    }

    // Désignation du favori sur la force globale (forme + niveau)
    const favoriDom = force(dom) !== force(ext)
      ? force(dom) > force(ext)
      : dgm(dom) >= dgm(ext);
    const fav = favoriDom ? dom : ext;
    const out = favoriDom ? ext : dom;

    // 1. FORME DU COLLECTIF (40 pts) — 40 % du score.
    // Combine la forme propre du favori et son avance de forme sur l'adversaire.
    const fForme = forme(fav);
    const oForme = forme(out);
    const ecartForme = (fForme - oForme + 1) / 2; // ramené sur [0, 1]
    const sForme = Math.round(
      40 * Math.min(1, Math.max(0, 0.5 * fForme + 0.5 * ecartForme)),
    );

    // 2. Attaque/défense croisée (30 pts)
    const att = fav.goalsFor / fav.playedGames;
    const def = out.goalsAgainst / out.playedGames;
    const sAttDef = Math.min(30, Math.max(0, Math.round((att + def - 1) * 10)));
    // 3. Dominance / différence de buts (20 pts)
    const sDom = Math.min(20, Math.max(0, Math.round((dgm(fav) - dgm(out)) * 5)));
    // 4. Contexte / classement (10 pts)
    const sCtx = fav.position === 1 && out.position >= 3 ? 10
      : fav.position === 1 ? 7 : 3;

    const score = sForme + sDom + sAttDef + sCtx;

    // Règle à trois étages
    let statut: string, marche: string | null = null, prediction: string | null = null;
    if (score >= SEUIL_VICTOIRE) {
      statut = "publie";
      marche = "victoire";
      prediction = `${fav.team.name} gagne`;
    } else if (score >= SEUIL_NE_PERD_PAS) {
      statut = "publie";
      marche = favoriDom ? "double_chance_1X" : "double_chance_X2";
      prediction = `${fav.team.name} ne perd pas`;
    } else {
      statut = "sous_seuil";
    }

    const { data: ligne } = await supabase.from("matchs_analyses").upsert({
      ...base,
      favori: fav.team.name,
      score_confiance: score,
      detail_scores: { forme: sForme, dominance: sDom,
        attaque_defense: sAttDef, contexte: sCtx },
      statut,
    }, { onConflict: "fixture_id" }).select().single();

    analyses++;

    if (statut === "publie" && ligne && marche && prediction) {
      await supabase.from("pronostics_publies").upsert({
        match_id: ligne.id,
        fixture_id: m.id,
        marche,
        prediction,
        score_confiance: score,
      }, { onConflict: "fixture_id", ignoreDuplicates: true });
      publies++;
    }
  }

  return new Response(JSON.stringify(
    { ok: true, date: auj, analyses, publies, exclus }, null, 2,
  ), { headers: { "Content-Type": "application/json" } });
});
