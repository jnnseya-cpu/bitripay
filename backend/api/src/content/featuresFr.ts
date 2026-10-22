/**
 * Le catalogue des fonctionnalités en français.
 *
 * Chaque entrée fournit exactement la même forme que l'anglais : la phrase qu'un concurrent ne peut pas dire, le
 * problème dans les mots du client, le fonctionnement, les faits vérifiables, le prix, les questions et l'article.
 * Un champ manquant fait échouer un test plutôt que de laisser un paragraphe en anglais au milieu d'une page
 * française.
 *
 * La disponibilité n'est écrite nulle part ici non plus : elle est calculée à partir de l'état réel des modules, en
 * français comme en anglais.
 */
import type { FeatureText } from './features';

export const FEATURES_FR: Record<string, FeatureText> = {
  'qr-payments': {
    name: 'Paiements BitriQR',
    tagline: 'Un code au mur. Tous les payeurs qu’il peut atteindre.',
    headline: 'Un code imprimé, tous les payeurs : comment fonctionne BitriQR',
    excerpt:
      'Un terminal s’achète, se recharge et se remplace. Un code QR est une feuille de papier. Voici ce qui rend un code imprimé assez sûr pour être cloué au mur, et pourquoi le son compte plus que l’écran.',
    usp: 'Un seul code imprimé qui fonctionne pour un client avec l’application, un client avec seulement un appareil photo, et un client dont la banque n’a jamais entendu parler de BitriPay — parce que le code est de l’EMVCo en dessous et signé au-dessus.',
    audience: 'Vendeuses de marché, boutiques, pharmacies, écoles, transporteurs — toute personne qui veut être payée sans terminal de carte.',
    problem:
      'Un terminal coûte de l’argent, doit être rechargé, exige un réseau et demande de savoir lire. Un simple numéro de mobile money oblige le client à saisir lui-même le montant, et vous discutez ensuite de ce qui est arrivé. Ni l’un ni l’autre ne tient devant une file de six personnes.',
    how: [
      'Imprimez le code une fois. Il ne change jamais : il peut être plastifié et cloué au mur.',
      'Pour un montant précis, ouvrez le point de vente, tapez le total, et l’écran affiche un code à usage unique contenant déjà le montant.',
      'Le client scanne. Un utilisateur BitriPay paie en un geste ; toute autre personne arrive sur une page de paiement qui propose les rails que son institution prend en charge.',
      'Le téléphone déclenche une alarme forte et vibre quand l’argent arrive réellement — pas quand le client affirme l’avoir envoyé.',
    ],
    proof: [
      'Le contenu du code est un QR marchand EMVCo avec un CRC : un portefeuille qui lit déjà l’EMVCo sait le lire.',
      'Une extension signée porte le marchand, le terminal et le montant, vérifiée contre un registre de clés Ed25519 qui gère la rotation.',
      'Chaque code peut être révoqué avec un motif — perdu, volé, altéré, remplacé, retiré — et un code révoqué cesse immédiatement de répondre.',
      'Les statistiques de scan sont conservées par code : une commerçante voit quelle feuille imprimée sert réellement.',
    ],
    cost: 'Recevoir sur un portefeuille personnel est gratuit. Un compte marchand paie le pourcentage affiché dans son tableau de bord avant la vente, et un paiement porté par le switch national porte les frais d’agrégation fixés dans la console. Rien n’est prélevé que le tableau de bord n’ait montré d’abord.',
    faq: [
      {
        question: 'Le client a-t-il besoin de l’application BitriPay ?',
        answer:
          'Non. Un utilisateur BitriPay paie en un scan. Toute autre personne ouvre le même code avec l’appareil photo de son téléphone et arrive sur une page de paiement qui propose les rails dont elle dispose ; le marchand reçoit l’argent de la même manière.',
      },
      {
        question: 'Qu’est-ce qui empêche quelqu’un de coller son propre code par-dessus le mien ?',
        answer:
          'Le code porte une signature sur le marchand et le montant, vérifiée contre un registre de clés publié avant que quoi que ce soit ne soit montré au payeur. Un code modifié ne répond pas, et le payeur voit un refus plutôt qu’un écran de paiement.',
      },
      {
        question: 'Je lis mal. Comment savoir que j’ai été payée ?',
        answer:
          'Le téléphone déclenche une alarme forte et vibre plusieurs secondes, et l’écran affiche le montant en gros chiffres avec une coche verte. S’il n’y a pas de son, il n’y a pas d’argent — une capture d’écran sur le téléphone du client n’est pas un paiement.',
      },
    ],
    articleSlug: 'paiements-par-code-qr-explique',
    article: `Un terminal de carte est un équipement. Un code QR est une feuille de papier. Cette différence décide qui peut encaisser un paiement numérique sur la plupart des marchés que BitriPay sert, et c’est toute la raison d’être de BitriQR.

## Le problème des solutions habituelles

Un terminal doit être acheté, rechargé, ramené à la maison le soir et remplacé quand il casse. Il lui faut son propre réseau. Il suppose que quelqu’un au stand sait lire l’écran.

La réponse courante est de peindre un numéro de mobile money sur une planche. Cela marche jusqu’à ce que le client se trompe de montant, paie le stand d’à côté, ou vous montre une capture d’écran et reparte avec le poisson. Vous n’avez ni référence, ni trace, ni argument.

## Ce que change un code signé

BitriQR est un code QR marchand EMVCo — la norme qu’un portefeuille bancaire lit déjà — avec une extension signée par-dessus. Cette extension porte l’identité du marchand, le terminal auquel il appartient et, pour un code à usage unique, le montant exact.

Cette signature est vérifiée contre un registre de clés publié avant que le payeur ne voie quoi que ce soit. Modifiez un seul caractère et le code cesse de répondre. Imprimez le vôtre et collez-le sur celui d’un autre : il ne devient pas le sien, il ne devient rien.

Les codes peuvent être révoqués avec un motif — perdu, volé, altéré, remplacé, retiré — et un code révoqué cesse de fonctionner à l’instant où il est révoqué, pas le lendemain.

## Deux codes, deux usages

**Le code du stand ne change jamais.** Imprimez-le une fois, plastifiez-le, clouez-le au mur. Le client scanne et saisit ce qu’il doit. C’est le code d’une commerçante qui a une file devant elle.

**Le code à usage unique porte le montant.** Ouvrez le point de vente, tapez le total, montrez l’écran. Le client scanne et le montant est déjà rempli. Il n’y a rien à mal saisir, donc rien à contester. C’est le code d’une pharmacie, d’un guichet de frais scolaires, d’une boutique qui affiche ses prix.

## Le son est le reçu

Quand l’argent arrive réellement, le téléphone déclenche une alarme forte et vibre, et l’écran affiche le montant en gros chiffres avec une coche verte et le nom du payeur. C’est conçu pour être entendu dans un marché bruyant et compris sans lire.

La règle, pour quiconque encaisse, tient en une phrase : **s’il n’y a pas eu de son, il n’y a pas eu d’argent.** Une capture d’écran sur le téléphone du client n’est pas un paiement. C’est une image.

## Ce que cela coûte

Recevoir sur un portefeuille personnel est gratuit. Un compte marchand paie le pourcentage affiché dans son tableau de bord, et un paiement porté par le switch national porte les frais d’agrégation fixés dans la console. Les deux sont visibles avant la vente, pas découverts ensuite sur un relevé.

## Par où commencer

Ouvrez un compte marchand, allez dans Recevoir, et appuyez sur Agrandir. Imprimez ce que vous voyez. Vous encaissez des paiements numériques dès que l’encre est sèche.`,
  },

  'payment-links': {
    name: 'Liens de paiement',
    tagline: 'Être payé en envoyant un message.',
    headline: 'Être payé dans la conversation où la vente s’est faite',
    excerpt:
      'Ici, la plupart des ventes se font dans une conversation et se terminent par un numéro de mobile money que personne ne peut rattacher à une commande. Un lien de paiement transporte le motif avec l’argent : la commande et le paiement deviennent le même enregistrement.',
    usp: 'Un lien que vous collez dans WhatsApp et qui se comporte comme une vraie page de paiement — réutilisable ou à usage unique, avec une expiration, une référence et une notification quand il est payé.',
    audience: 'Toute personne qui vend par WhatsApp, Facebook ou téléphone : tailleurs, mécaniciens, consultants, vendeurs en ligne, écoles qui collectent des frais.',
    problem:
      'L’essentiel de la vente dans la région se fait dans une fenêtre de discussion. Le vendeur n’a ni site ni terminal : la conversation se termine par un numéro de mobile money et une promesse. Rien ne relie l’argent à la commande.',
    how: [
      'Créez un lien avec un montant, une description et une référence — ou laissez le montant ouvert et laissez le payeur le saisir.',
      'Choisissez usage unique pour une facture, ou réutilisable pour un produit que vous vendez sans cesse.',
      'Collez-le dans la conversation. Le payeur ouvre une page de paiement qui porte votre nom et le motif du paiement.',
      'Le paiement arrive rattaché à votre référence : la commande et l’argent sont le même enregistrement.',
    ],
    proof: [
      'Un lien peut être désactivé à tout moment, et un lien désactivé cesse immédiatement d’accepter des paiements.',
      'Chaque lien porte sa propre référence, qui apparaît sur le paiement, sur le relevé et sur la notification.',
      'Les liens se créent depuis le tableau de bord ou depuis l’API en un appel : un système de boutique peut en émettre un par facture.',
      'Un lien payé déclenche la même notification signée que n’importe quel paiement : une commande peut être marquée payée sans que personne ne surveille un écran.',
    ],
    cost: 'Créer un lien ne coûte rien. Le paiement qu’il encaisse porte le tarif marchand habituel affiché dans le tableau de bord.',
    faq: [
      {
        question: 'Puis-je utiliser un seul lien pour tout ?',
        answer:
          'Oui — un lien réutilisable à montant ouvert fonctionne comme un lien « payez-moi » général. Pour des factures, un lien à usage unique avec le montant et la référence déjà fixés vaut mieux, parce que le paiement arrive rattaché à la commande.',
      },
      {
        question: 'Et si j’envoie le lien à la mauvaise personne ?',
        answer: 'Désactivez-le. Un lien désactivé cesse aussitôt d’accepter des paiements, et le tableau de bord l’affiche comme inactif avec l’heure de son arrêt.',
      },
      { question: 'Le payeur doit-il avoir un compte ?', answer: 'Non. Le lien ouvre une page de paiement hébergée qui propose les rails dont ce payeur dispose.' },
    ],
    articleSlug: 'liens-de-paiement-explique',
    article: `L’essentiel de la vente à Kinshasa ne passe pas par un site web. Cela se passe dans une conversation — une photo de la marchandise, un prix, un accord, puis le moment gênant : *envoyez à ce numéro*.

Ce moment gênant est précisément celui où l’argent et la commande cessent d’être la même chose.

## Ce qui ne va pas avec un numéro

Vous publiez un numéro de mobile money. Trois clients le paient le même après-midi. L’un se trompe de montant, l’autre paie depuis le téléphone de son cousin, et le troisième paie un numéro capturé dans un message plus ancien qui appartient à quelqu’un d’autre.

Vous voilà enquêteur. Quel paiement correspondait à quelle commande ? À qui doit-on la marchandise ? Vous avez une liste de montants sans aucune référence, et le seul moyen de les rapprocher est votre mémoire.

## Un lien transporte le motif avec l’argent

Un lien de paiement est une adresse web qui sait déjà à quoi elle sert. Elle porte votre nom, le montant si vous en fixez un, une description que le payeur peut lire, et une référence que vous choisissez.

Collez-le dans la conversation où la vente s’est faite. Le client appuie dessus, arrive sur une page qui dit qui vous êtes et ce qu’il paie, et règle avec le rail dont il dispose.

Le paiement arrive **rattaché à votre référence**. La commande 1042 est payée par la personne à qui le lien de la commande 1042 a été envoyé. Il n’y a rien à rapprocher à la main.

## Usage unique ou réutilisable

**L’usage unique** est fait pour une facture. Un lien, un paiement, puis il se ferme. Si le client le transfère à un ami, l’ami ne peut pas le payer une seconde fois.

**Le réutilisable** est fait pour un produit que vous vendez sans cesse — une coupe de cheveux, des frais de livraison, un abonnement mensuel à votre service. Épinglez-le dans la description de votre boutique et laissez-le travailler toute l’année.

L’un comme l’autre peuvent être désactivés dès que vous le voulez. Un lien désactivé refuse immédiatement les paiements ; il ne continue pas d’encaisser pendant que vous dormez.

## Pour qui tient un système de boutique

Les liens se créent en un appel d’API. Une boutique, un système de frais scolaires ou un outil de facturation peut émettre un lien par facture, avec le numéro de facture comme référence, et recevoir une notification signée dès qu’il est payé. La commande est marquée payée par un logiciel, pas par quelqu’un qui rafraîchit une page.

## Ce que cela coûte

Créer des liens est gratuit. Vous payez le tarif marchand habituel sur l’argent qu’ils encaissent, affiché dans votre tableau de bord avant que vous n’envoyiez quoi que ce soit.

## Par où commencer

Ouvrez un compte marchand, allez dans Liens de paiement, et créez-en un pour ce que vous vendez le plus souvent. Mettez-le dans votre profil WhatsApp. Il fonctionnera encore l’année prochaine.`,
  },

  'money-requests': {
    name: 'Demandes d’argent',
    tagline: 'Demandez une fois. Cela les attend.',
    headline: 'La façon polie de se faire rembourser',
    excerpt:
      'Demander de l’argent à quelqu’un qu’on connaît coûte plus cher que l’argent lui-même. Une demande qui attend dans son application, qu’il approuve d’une empreinte, et qui ne peut jamais rien prélever d’elle-même, change le calcul.',
    usp: 'Une demande qui arrive comme une notification que l’autre approuve d’une empreinte, au lieu d’un message qu’il doit se rappeler de traiter.',
    audience: 'Toute personne à qui quelqu’un qu’elle connaît doit de l’argent : bailleurs, répétiteurs, tontines, amis qui partagent une addition, petits fournisseurs.',
    problem: 'Demander de l’argent par message coûte cher socialement et s’ignore facilement. Vous envoyez un numéro, on vous dit « plus tard », et « plus tard » n’a aucun rappel attaché.',
    how: [
      'Choisissez à qui vous demandez, le montant et le motif.',
      'La personne reçoit une notification avec votre nom, le montant, le motif et un seul bouton d’approbation.',
      'Approuver demande une empreinte ou un code ; l’argent bouge en une seule écriture comptable.',
      'Tant qu’elle n’a pas approuvé, la demande reste visible dans son application, et dans la vôtre où vous pouvez l’annuler.',
    ],
    proof: [
      'Une demande n’est jamais un prélèvement : rien ne bouge tant que l’autre partie n’a pas approuvé avec son propre moyen d’authentification.',
      'Les deux parties voient le même enregistrement avec le même statut : il n’y a pas de discussion sur l’envoi.',
      'Une demande peut être annulée par celui qui l’a envoyée, et une demande annulée ne peut plus être approuvée.',
      'Le motif voyage avec la demande et se retrouve sur les deux relevés.',
    ],
    cost: 'Demander est gratuit. Le transfert qui en résulte porte le tarif habituel d’un transfert entre comptes, affiché avant approbation.',
    faq: [
      {
        question: 'Quelqu’un peut-il prendre de l’argent sur mon compte en envoyant une demande ?',
        answer:
          'Non. Une demande est une demande, pas un prélèvement. Rien ne quitte votre compte tant que vous n’avez pas approuvé avec votre propre empreinte ou votre code, et vous pouvez refuser.',
      },
      {
        question: 'Et si la personne l’ignore ?',
        answer: 'Elle reste dans son application comme une demande ouverte, visible à chaque ouverture — ce qui est nettement plus difficile à oublier qu’un message qui a défilé.',
      },
      { question: 'Puis-je annuler une demande envoyée par erreur ?', answer: 'Oui, et une fois annulée elle ne peut plus être approuvée. Vous voyez tous les deux qu’elle a été annulée et quand.' },
    ],
    articleSlug: 'demandes-d-argent-explique',
    article: `Demander de l’argent à quelqu’un qu’on connaît est la transaction la plus gênante de toute la finance. Pas de facture, pas de conditions, pas de service de recouvrement — juste vous, en train de décider combien de fois vous pouvez en reparler avant que cela ne vous coûte la relation.

## Pourquoi un message ne marche pas

Vous envoyez le numéro. On vous répond *bien sûr, ce soir*. Le message défile. Une semaine plus tard, vous devez décider si vous relancez, et c’est cette décision qui coûte cher. La plupart des gens ne relancent tout simplement pas, et l’argent devient discrètement un cadeau.

Le problème n’est pas la malhonnêteté. C’est qu’un message de discussion n’a pas d’état. Il ne se range nulle part. Il n’attend pas.

## Une demande attend

Une demande d’argent arrive comme une notification portant votre nom, le montant et le motif. Elle ne défile pas. Elle reste dans l’application comme un élément ouvert, visible à chaque ouverture, avec un seul bouton d’approbation.

Cela change complètement l’arithmétique sociale. Vous avez demandé une fois. Le rappel est assuré par le logiciel, qui n’a aucun sentiment à ce sujet et ne se fatigue jamais.

## Elle ne peut rien prélever

C’est la partie qu’il faut énoncer précisément, parce que c’est elle qui rend la fonction utilisable entre personnes qui ne sont pas de la même famille.

Une demande est une **demande**, jamais un prélèvement. Rien ne quitte le compte de l’autre tant qu’il n’a pas approuvé avec sa propre empreinte ou son propre code. Il peut refuser. Quelqu’un qui vous envoie une demande n’a obtenu aucun accès à votre argent — il vous a envoyé une question.

## Les deux parties voient la même chose

Vous voyez ce que vous avez envoyé et son statut. L’autre voit ce qui est demandé et par qui. À l’approbation, les deux relevés portent le motif que vous avez saisi.

Si vous l’avez envoyée par erreur, annulez-la. Une demande annulée ne peut plus être approuvée, et vous voyez tous les deux qu’elle l’a été et quand. Il n’y a pas deux versions des faits.

## À qui cela s’adresse vraiment

Aux bailleurs qui réclament un loyer à des locataires qu’ils croisent tous les jours. Aux répétiteurs payés au mois par des parents. Aux tontines qui collectent une cotisation hebdomadaire. Aux fournisseurs qui livrent d’abord et facturent ensuite. À toute personne dont la relation avec le débiteur survit à la dette et ne peut donc pas se permettre un affrontement.

## Ce que cela coûte

Demander est gratuit. Le transfert qui suit porte le tarif habituel d’un transfert entre comptes, affiché au payeur avant qu’il n’approuve.`,
  },
  'hosted-checkout': {
    name: 'Page de paiement hébergée',
    tagline: 'Une page qui ne propose que ce qui marchera.',
    headline: 'Une page de paiement qui ne propose que ce qui va réellement fonctionner',
    excerpt:
      'Chaque paiement abandonné fait perdre un client qui avait déjà dit oui. Au lieu d’aligner huit logos en espérant, la page détermine quels rails peuvent conclure ce paiement, pour ce payeur, à cette minute — et n’affiche que ceux-là.',
    usp: 'Une page de paiement qui ne propose au payeur que les rails capables de conclure réellement son paiement, décidés au moment où il arrive plutôt qu’énumérés avec optimisme sur une page.',
    audience: 'Boutiques en ligne, places de marché, systèmes de facturation, sites de réservation et toute entreprise qui envoie ses clients payer ailleurs.',
    problem:
      'Une page qui aligne dix logos et échoue sur huit apprend aux clients à abandonner. Pire, elle échoue après qu’ils se sont engagés, c’est-à-dire au moment le plus coûteux pour les perdre.',
    how: [
      'Créez une intention de paiement ou une session avec le montant, la devise et votre référence.',
      'Envoyez le client vers l’adresse retournée, ou affichez le contenu QR retourné.',
      'La page détermine quels rails peuvent porter ce paiement, pour ce payeur, maintenant — et n’affiche que ceux-là.',
      'Au paiement, vous recevez une notification signée et le client revient sur votre page de succès.',
    ],
    proof: [
      'Les rails proposés sont calculés par paiement, à partir du corridor, de la devise, du payeur et de la santé en temps réel de chaque connecteur.',
      'Un rail dont le disjoncteur est ouvert n’est pas proposé : un client n’est jamais envoyé sur un chemin qui échoue en ce moment.',
      'Sous le périmètre d’agrégateur, la page ne propose que le rail du switch et refuse le reste, plutôt que d’afficher des options que la plateforme n’a peut-être pas le droit d’exploiter.',
      'La session porte les lignes de vente avec la TVA lorsque le marchand les utilise : le client voit ce qu’on lui facture.',
    ],
    cost: 'La page hébergée fait partie de la passerelle marchande ; elle n’est pas facturée à part. Vous payez le tarif du rail qui porte le paiement, affiché dans le tableau de bord.',
    faq: [
      {
        question: 'Puis-je y mettre ma marque ?',
        answer: 'La page porte le nom de votre entreprise, votre référence et vos lignes de vente, et renvoie le client vers vos propres adresses de succès et d’annulation.',
      },
      {
        question: 'Que se passe-t-il si un rail tombe en pleine vente ?',
        answer:
          'Un connecteur dont le disjoncteur s’est ouvert cesse d’être proposé : les nouveaux clients sont déroutés autour de lui plutôt que dedans. Un paiement déjà en cours suit sa propre machine d’états et n’est jamais marqué payé sans confirmation.',
      },
      {
        question: 'Suis-je obligé d’utiliser la page hébergée ?',
        answer: 'Non. La même intention peut être affichée en QR, intégrée avec une clé publiable, ou pilotée entièrement depuis l’API si vous voulez construire l’écran vous-même.',
      },
    ],
    articleSlug: 'page-de-paiement-hebergee-explique',
    article: `Tous les paiements abandonnés ont la même forme. Le client a décidé d’acheter. Il a sorti son téléphone. Et là, la page lui propose huit façons de payer, dont deux fonctionneront réellement, et il l’apprend échec après échec.

C’est l’endroit le plus coûteux de tout le tunnel pour perdre quelqu’un, parce que c’est le seul où il avait déjà dit oui.

## Les listes sont optimistes. Le routage ne l’est pas.

La plupart des pages de paiement affichent une liste fixe de logos. Cette liste décrit ce que l’entreprise a signé, pas ce qui fonctionnera pour la personne qui est là.

La page de BitriPay pose une autre question : *pour ce paiement, cette devise, ce payeur, à cette minute — qu’est-ce qui peut réellement aboutir ?* Elle y répond à partir du corridor auquel appartient le paiement, de la devise et de la santé en temps réel de chaque connecteur, et n’affiche que ce qui survit à ce test.

Un connecteur dont le disjoncteur s’est ouvert n’est pas sur la page. Pas grisé — absent. Le client est dérouté autour d’un rail défaillant au lieu d’y être envoyé, et il n’apprend jamais qu’il était défaillant.

## Elle refuse plutôt que de faire semblant

Cela compte plus qu’il n’y paraît. Sous le périmètre d’agrégateur, la page ne propose que le rail du switch et refuse tout le reste, parce que la plateforme n’a pas le droit d’exploiter le reste tant que l’autorisation correspondante n’existe pas.

Une page qui proposerait quand même ces options ferait une promesse que la plateforme n’a pas le droit de tenir. La nôtre préfère montrer une option qui marche plutôt que quatre pleines d’espoir.

## Ce que voit le client

Le nom de votre entreprise, votre référence et vos lignes de vente avec la TVA lorsque vous les utilisez — il regarde donc ce qu’il achète, et non un montant nu qu’il doit croire sur parole.

Une fois payé, il revient sur votre propre page de succès, et vous recevez une notification signée portant la référence que vous avez fixée. Votre commande est marquée payée par un logiciel.

## Vous n’êtes pas obligé d’utiliser la page

La même intention de paiement peut être une page hébergée, un contenu QR, un panneau intégré piloté par une clé publiable, ou des appels d’API bruts dans un écran que vous avez construit. Le routage est le même dans tous les cas ; seule la surface change.

## Ce que cela coûte

La page hébergée fait partie de la passerelle marchande. La page n’est pas facturée. Vous payez le tarif du rail qui a porté le paiement, et votre tableau de bord affiche ce tarif avant la vente, pas après.`,
  },

  'point-of-sale': {
    name: 'Point de vente',
    tagline: 'La caisse est le téléphone que vous avez déjà.',
    headline: 'Votre caisse est le téléphone dans votre poche',
    excerpt:
      'Une caisse fait trois choses : additionner les articles, calculer la taxe correctement, produire un reçu accepté des deux côtés. Aucune n’exige du matériel. Lignes de vente, TVA par ligne, un total que personne ne saisit, et des comptes pour le personnel qui ne livrent pas l’entreprise.',
    usp: 'Une caisse qui tourne sur le téléphone déjà dans la main du commerçant, avec lignes de vente et TVA, et aucun matériel à acheter, recharger ou remplacer.',
    audience: 'Boutiques, pharmacies, restaurants, quincailleries et toute entreprise qui vend plusieurs choses à la fois.',
    problem:
      'Une entreprise qui vend plusieurs articles à la fois ne peut pas être payée avec un simple numéro. Il lui faut un total construit à partir de ses parties, une ligne de taxe correcte et un reçu que le client accepte — et la façon habituelle d’obtenir cela est une machine qui coûte plus qu’un mois de bénéfice.',
    how: [
      'Ajoutez les articles à la vente sur le téléphone, avec les quantités.',
      'La TVA s’applique par ligne au taux fixé pour l’entreprise, et le total se construit à partir des lignes au lieu d’être saisi.',
      'Montrez le code à usage unique ; le client scanne et le montant est déjà rempli.',
      'Le reçu porte les lignes, la taxe et la référence, et reste attaché à la vente.',
    ],
    proof: [
      'Les lignes de vente portent une quantité et un taux de TVA par ligne : la taxe d’un panier mixte est juste, pas approchée.',
      'Le total est calculé à partir des lignes : un total mal saisi n’est pas possible.',
      'Le reçu et le détail du paiement affichent les mêmes lignes que celles acceptées par le client.',
      'Le personnel peut recevoir ses propres identifiants avec un rôle de caissier dont la limite de remboursement est fixée par organisation.',
    ],
    cost: 'Aucun matériel et aucune licence. La vente porte le tarif marchand habituel affiché dans le tableau de bord.',
    faq: [
      {
        question: 'Mon personnel peut-il l’utiliser sans tout voir ?',
        answer:
          'Oui. Un caissier se connecte avec son propre compte, peut encaisser et rembourser jusqu’à la limite fixée par l’entreprise, mais ne peut pas changer les instructions de règlement, lire les secrets d’API ni exporter les clients.',
      },
      { question: 'Cela marche-t-il pour une entreprise sans TVA ?', answer: 'Mettez le taux à zéro et les lignes ne portent aucune taxe. Les totaux et le reçu fonctionnent de la même façon.' },
      {
        question: 'Et si le client veut un reçu papier ?',
        answer: 'Le reçu est une page qui peut être imprimée ou montrée à l’écran, et elle porte les mêmes lignes, la même taxe et la même référence que celles attachées à la vente.',
      },
    ],
    articleSlug: 'point-de-vente-explique',
    article: `Une commerçante qui vend une seule chose peut être payée avec un seul numéro. Une pharmacie, non. Une quincaillerie, non. Un restaurant, certainement pas. Dès qu’une vente est faite de plusieurs parties, il faut une caisse — et une caisse a toujours voulu dire du matériel.

## À quoi servait vraiment le matériel

Retirez le plastique et une caisse fait trois choses : elle additionne les parties, elle calcule la taxe correctement, et elle produit un reçu que les deux parties acceptent.

Aucune des trois n’exige une machine. Elles exigent un logiciel et un écran. Le commerçant tient déjà un écran.

## Construit à partir des lignes, pas saisi

La vente est assemblée à partir d’articles avec des quantités. La TVA s’applique par ligne, au taux fixé pour l’entreprise : un panier qui mélange des biens taxés et non taxés tombe juste, et pas à peu près juste.

Le total est ensuite **calculé à partir des lignes**. Personne ne le saisit. Cela paraît mineur jusqu’à ce qu’on compte combien de litiges, dans une petite boutique, viennent d’un total mal tapé et remarqué trop tard.

Le téléphone affiche alors un code à usage unique contenant déjà le montant. Le client scanne et paie. Aucun numéro à lire à voix haute, aucun montant à mal saisir, et aucune discussion sur ce qui était dû.

## Le reçu est l’enregistrement

Ce que le client voit sur le reçu — les lignes, les quantités, la taxe, la référence — est ce qui est conservé contre la vente dans vos archives. Imprimez-le ou montrez-le à l’écran : c’est le même enregistrement.

## Du personnel sans livrer l’entreprise

C’est là que la plupart des petites boutiques se bloquent : le propriétaire ne peut pas tenir le comptoir toute la journée, mais confier le téléphone à un employé revient généralement à tout lui confier.

Le personnel reçoit ses propres identifiants avec un rôle de caissier. Un caissier encaisse et peut rembourser jusqu’à une limite fixée par l’entreprise. Un caissier ne peut pas changer la destination des règlements, ne peut pas lire les secrets d’API, et ne peut pas exporter la liste des clients. Le propriétaire fixe la limite ; le logiciel l’applique, à chaque fois, sans discussion.

## Ce que cela coûte

Aucun matériel, aucune licence, aucune location mensuelle. Vous payez le tarif marchand habituel sur ce que vous vendez, affiché dans votre tableau de bord.

La caisse pour laquelle vous économisiez est le téléphone dans votre poche.`,
  },

  'developer-api': {
    name: 'L’API de la passerelle',
    tagline: 'Trois appels et une notification.',
    headline: 'Trois appels et une notification : l’API BitriPay',
    excerpt:
      'La documentation est produite à partir de la même table qui sert les requêtes : elle ne peut pas décrire un point de terminaison qui n’existe pas. Une idempotence qui refuse au lieu de dupliquer, des erreurs sur lesquelles brancher, et un bac à sable qui échoue correctement.',
    usp: 'Une API de paiement dont la documentation est produite à partir de la même table qui sert les requêtes : la référence ne peut donc jamais décrire un point de terminaison que la plateforme n’a pas.',
    audience: 'Développeurs qui intègrent le paiement dans une boutique, un système de facturation, une place de marché, une plateforme scolaire ou le logiciel d’une institution.',
    problem:
      'Intégrer un paiement, c’est d’habitude lire une documentation vraie le trimestre dernier, découvrir le comportement réel dans les messages d’erreur, et écrire une logique de reprise parce que l’idée que le prestataire se fait de l’idempotence est une suggestion.',
    how: [
      'Créez une intention de paiement avec un montant, une devise et votre référence.',
      'Envoyez le client vers son adresse de paiement, ou affichez son contenu QR.',
      'Agissez sur la notification signée quand le paiement réussit ou se règle.',
      'Rapprochez avec le relevé ; chaque objet porte la référence que vous lui avez donnée.',
    ],
    proof: [
      'Le document OpenAPI et la référence lisible sont produits à partir d’une seule table d’opérations : ils ne peuvent pas se contredire.',
      'Chaque POST qui déplace de l’argent exige une clé d’idempotence : un rejeu renvoie l’objet d’origine, et la même clé avec un corps différent est refusée.',
      'Les notifications sont signées deux fois — HMAC-SHA256 sur le corps horodaté, et une signature Ed25519 de la plateforme — et réessayées selon un calendrier publié sur 24 heures.',
      'Les erreurs portent un code descriptif et une famille numérique stable : un logiciel peut brancher sur la famille sans analyser de l’anglais.',
      'Un bac à sable avec des numéros magiques documentés pilote la vraie machine d’états, échecs compris, sans toucher à un opérateur.',
    ],
    cost: 'L’API ne coûte rien. Vous payez les paiements qu’elle déplace, au tarif de votre compte.',
    faq: [
      {
        question: 'Comment tester un échec ?',
        answer:
          'Le bac à sable publie des numéros magiques qui produisent des issues précises — succès, solde insuffisant, délai dépassé puis succès — à travers la même machine de tentatives qu’en production. Vous testez les chemins malheureux sans opérateur et sans faire semblant.',
      },
      {
        question: 'Que se passe-t-il si mon serveur réessaie un paiement ?',
        answer:
          'Envoyez la même clé d’idempotence et vous récupérez l’objet d’origine au lieu d’un second paiement. La même clé avec un corps différent est refusée nettement, ce qui transforme un bug dangereux en une erreur lisible.',
      },
      {
        question: 'Comment savoir qu’une notification vient bien de vous ?',
        answer:
          'Chaque livraison porte un HMAC horodaté sur le corps exact avec le secret de votre point de terminaison, plus une signature Ed25519 de la clé de plateforme que vous pouvez récupérer dans le registre. Vérifiez l’une ou les deux, et rejetez tout ce qui a plus de cinq minutes.',
      },
    ],
    articleSlug: 'api-de-paiement-explique',
    article: `La plupart des intégrations de paiement sont de l’archéologie. Vous lisez la documentation, découvrez qu’elle décrit l’API de l’an dernier, et apprenez le comportement réel dans les messages d’erreur, en production, à onze heures du soir.

Nous avons pris tôt une décision qui supprime l’essentiel de cela : **la documentation est produite à partir de la même table qui sert les requêtes.**

## Une table, deux rendus

Il existe une seule liste d’opérations à l’intérieur de la plateforme. Le document OpenAPI en est produit. La référence lisible en est produite. Les requêtes en sont servies.

Ce n’est pas une politique de documentation, c’est une décision d’architecture, et elle a une conséquence précise : la référence ne peut pas décrire un point de terminaison qui n’existe pas, et un point de terminaison ne peut pas exister sans apparaître dans la référence. Ce sont deux rendus du même objet.

## Une idempotence qui refuse réellement

Chaque POST qui déplace de l’argent exige une clé d’idempotence.

Envoyez deux fois la même clé avec le même corps et vous récupérez l’objet d’origine — pas de second paiement. Envoyez la même clé avec un corps **différent** et la requête est **refusée**, avec une erreur précise, au lieu de créer quelque chose en silence.

C’est cette seconde règle qui compte. Une collision de clés dans votre code est un bug qui apparaîtrait autrement sous forme de double débit mystérieux des semaines plus tard. Ici il apparaît comme un 409 avec un message lisible, pendant les tests, là où les bugs sont bon marché.

## Des notifications signées deux fois

Chaque livraison porte un HMAC-SHA256 horodaté sur le corps exact, avec le secret propre à votre point de terminaison. Elle porte aussi une signature Ed25519 de la clé de la plateforme, que vous pouvez récupérer dans un registre public gérant la rotation.

Vérifiez l’une. Vérifiez les deux. Rejetez tout horodatage de plus de cinq minutes et le rejeu est fermé.

La livraison est au moins une fois, selon un calendrier de reprise publié qui s’étale sur 24 heures, et chaque événement a un identifiant pour la déduplication. Nous disons « au moins une fois » parce que c’est le cas ; un prestataire qui promet « exactement une fois » décrit une chose qu’il ne peut pas livrer.

## Des erreurs sur lesquelles brancher

Chaque échec renvoie \`error.code\` — descriptif, pour un humain qui lit un journal — et \`error.bp\`, une famille numérique stable : authentification, validation, grand livre, rail, conformité, intelligence.

Branchez sur la famille. Elle ne change pas quand nous améliorons un message, et elle n’oblige pas votre code à analyser de l’anglais.

## Un bac à sable qui échoue correctement

Les clés de test pilotent la même machine d’états que la production. Le bac à sable publie des numéros magiques pour des issues précises : succès, solde insuffisant, délai dépassé puis succès.

Ce dernier est celui que personne d’autre ne vous donne, et c’est celui qui trouve le bug de votre logique de reprise avant vos clients.

## Par où commencer

La référence est sur **/developers/api** — chaque opération avec sa portée, ses paramètres, ses champs et un exemple prêt à copier. Le document lisible par machine est le même contenu en OpenAPI 3.1.

Trois appels et une notification. Le café sera encore chaud.`,
  },

  webhooks: {
    name: 'Notifications signées',
    tagline: 'Votre logiciel l’apprend avant votre client.',
    headline: 'Des notifications auxquelles vous pouvez vous fier, et que vous ne pouvez pas perdre',
    excerpt:
      'Une notification vaut ce que vaut votre capacité à la vérifier et à survivre à celle que vous ratez. Deux signatures indépendantes, un calendrier de reprise publié sur 24 heures, des identifiants d’événement pour dédupliquer, et une boîte de réception pour avant que votre serveur n’existe.',
    usp: 'Des livraisons que vous pouvez vérifier de deux façons indépendantes, rejouer vous-même depuis le tableau de bord, et recevoir sur une boîte intégrée si vous n’avez encore nulle part où héberger un point de terminaison.',
    audience: 'Tout développeur dont le système doit réagir quand l’argent bouge : systèmes de commandes, plateformes scolaires, outils comptables, systèmes de livraison.',
    problem:
      'Interroger en boucle est coûteux, tardif et fragile. Les notifications ne résolvent cela que si vous pouvez distinguer une vraie d’une fausse, et seulement si une livraison qui échoue pendant que votre serveur redémarre n’est pas simplement perdue.',
    how: [
      'Enregistrez un point de terminaison et choisissez les événements qui vous intéressent.',
      'Vérifiez la signature à l’arrivée, répondez vite, et faites votre travail ensuite.',
      'Dédupliquez sur l’identifiant d’événement, car la livraison est au moins une fois par conception.',
      'Rejouez ce que vous voulez depuis le tableau de bord quand vous en avez besoin.',
    ],
    proof: [
      'Deux signatures par livraison : un HMAC-SHA256 sur le corps horodaté avec le secret de votre point de terminaison, et une signature Ed25519 du registre de clés de la plateforme.',
      'Les reprises suivent un calendrier publié sur 24 heures ; les livraisons ne sont pas abandonnées parce que votre serveur redémarrait.',
      'Chaque événement porte un identifiant : une livraison répétée peut être reconnue et ignorée.',
      'Une boîte de réception intégrée reçoit les événements d’un compte qui n’a encore nulle part où héberger un point de terminaison : l’intégration peut être construite avant le serveur.',
    ],
    cost: 'Inclus. Il n’y a pas de frais par livraison.',
    faq: [
      {
        question: 'Pourquoi « au moins une fois » et pas « exactement une fois » ?',
        answer:
          'Parce que la livraison « exactement une fois » sur un réseau n’existe pas, et qu’un prestataire qui la revendique décrit autre chose. Chaque événement a un identifiant ; dédupliquez dessus et vous obtenez un traitement exactement une fois, qui est ce que vous vouliez vraiment.',
      },
      {
        question: 'Mon serveur est tombé une heure. Qu’ai-je perdu ?',
        answer:
          'Rien de ce qui s’est produit dans la fenêtre de reprise. Les livraisons sont réessayées selon un calendrier publié sur 24 heures, et vous pouvez tout rejouer ensuite depuis le tableau de bord.',
      },
      {
        question: 'Je n’ai pas encore construit mon serveur.',
        answer:
          'Utilisez la boîte de réception intégrée. Les événements de votre compte arrivent quelque part où vous pouvez les lire : vous voyez la forme exacte d’un vrai événement avant d’écrire une ligne de code de traitement.',
      },
    ],
    articleSlug: 'notifications-signees-explique',
    article: `Une notification est la promesse que votre logiciel l’apprendra avant votre client. Cette promesse vaut exactement ce que valent votre capacité à faire confiance au message et votre capacité à survivre à celui que vous ratez.

## Lui faire confiance : deux signatures

Chaque livraison porte deux preuves indépendantes.

La première est un **HMAC-SHA256** sur le corps horodaté, avec le secret appartenant à votre point de terminaison. Si vous pouvez le vérifier, le message vient de quelqu’un qui détient ce secret et le corps n’a pas été modifié.

La seconde est une **signature Ed25519** de la clé propre à la plateforme, que vous récupérez dans un registre public gérant la rotation. Celle-ci ne dépend pas du tout du secret de votre point de terminaison, ce qui compte si ce secret s’est déjà trouvé dans un endroit dont vous n’êtes plus très sûr.

Vérifiez l’une. Vérifiez les deux. Puis rejetez tout horodatage de plus de cinq minutes, et le rejeu est fermé.

## Y survivre : reprises et identifiants

La livraison est **au moins une fois**. Nous le disons clairement parce que c’est vrai, et parce que l’affirmation contraire est du marketing.

Votre serveur tombera parfois. Les déploiements existent. Quand une livraison échoue, elle est réessayée selon un calendrier publié sur 24 heures — pas abandonnée parce que vous redémarriez.

La conséquence du « au moins une fois » est que vous recevrez parfois deux fois le même événement. Chaque événement porte un identifiant. Gardez ceux que vous avez traités et ignorez les répétitions : vous avez transformé une livraison au moins une fois en un **traitement** exactement une fois, qui est ce que vous vouliez depuis le début.

## Répondez vite, travaillez lentement

Accusez réception rapidement, puis faites votre travail. Si vous marquez la commande, envoyez le courriel au client et mettez à jour l’entrepôt avant de répondre, une étape lente quelque part dans cette chaîne devient une reprise, qui devient un doublon, qui devient un second courriel.

Prenez l’événement, stockez-le, répondez, et traitez depuis votre propre file.

## Le rejeu vous appartient

Tout peut être rejoué depuis le tableau de bord. Si vous avez livré un bug qui a perdu silencieusement une heure d’événements, vous n’avez besoin de demander de l’aide à personne — vous rejouez la fenêtre vous-même.

## Avant que votre serveur n’existe

Le moment inconfortable de toute intégration : il vous faut voir un vrai événement pour écrire le traitement, et il vous faut le traitement pour recevoir un vrai événement.

Il existe une boîte de réception intégrée. Les événements de votre compte arrivent quelque part où vous pouvez les lire : vous regardez la forme exacte d’un véritable événement — les vrais champs, les vraies valeurs — avant d’écrire une ligne de code contre lui.`,
  },

  'connected-accounts': {
    name: 'Comptes connectés',
    tagline: 'Intégrez vos clients par API. Transmettez quand ils sont prêts.',
    headline: 'Encaisser pour vos clients sans devenir une entreprise de paiement',
    excerpt:
      'Toute plateforme qui réussit atteint le jour où elle encaisse pour le compte de ses clients. Regroupez tout et vous détenez l’argent d’autrui sans licence. Voici la troisième option : ils sont le marchand de référence, et ils peuvent vous retirer quand ils veulent.',
    usp: 'Créez les comptes marchands de vos clients par API, encaissez pour eux avec votre propre clé, gardez votre commission — et transmettez le compte dès qu’ils sont prêts, clés et historique intacts.',
    audience: 'Places de marché, logiciels en ligne, systèmes de facturation, coopératives, plateformes scolaires et institutions qui encaissent pour le compte d’autrui.',
    problem:
      'Une plateforme qui encaisse pour ses clients devient soit une entreprise de paiement non agréée, soit oblige chaque client à passer par une inscription qu’elle ne contrôle pas. Ni l’un ni l’autre n’est une bonne position.',
    how: [
      'Créez le compte marchand du client en un appel ; il reçoit un lien pour en prendre possession.',
      'Encaissez pour lui avec votre propre clé, en ajoutant l’en-tête du compte à n’importe quelle opération.',
      'Gardez votre commission sous forme de partage transparent prélevé à la capture et visible sur les deux relevés.',
      'Envoyez le lien de prise de possession quand il doit se connecter lui-même ; détachez-vous quand la relation se termine.',
    ],
    proof: [
      'Le client est le marchand de référence : son argent arrive dans son portefeuille et se règle selon son profil de règlement.',
      'Votre commission est un partage sur le paiement, payé à la capture, visible des deux côtés plutôt que déduit invisiblement.',
      'Toute opération que votre clé peut faire pour vous, elle la fait pour un compte connecté avec un en-tête ; les portées s’appliquent toujours.',
      'À la prise de possession, le client vous voit dans son équipe comme administrateur, et il peut vous retirer à tout moment. Clés, portefeuilles et historique restent à lui.',
    ],
    cost: 'Aucuns frais pour créer ou détenir des comptes. Les paiements portent le tarif habituel, et votre commission de plateforme vous revient.',
    faq: [
      {
        question: 'Qui est la partie réglementée ?',
        answer:
          'BitriPay détient l’autorisation et reste la partie réglementée. Chacun de vos clients est le marchand de référence pour ses propres paiements, avec ses portefeuilles, son profil de règlement, ses relevés et sa vérification.',
      },
      {
        question: 'Que se passe-t-il quand un client me quitte ?',
        answer:
          'Il vous détache, ou vous vous détachez. Son compte, ses clés, son argent et son historique restent avec lui. Rien de ce qui lui appartient n’a jamais été détenu en votre nom : il n’y a rien à défaire.',
      },
      {
        question: 'Puis-je prendre une commission ?',
        answer:
          'Oui. Fixez une commission par défaut en points de base sur le compte, ou un montant fixe par paiement. Elle est prélevée à la capture comme un partage et apparaît sur les deux relevés : votre client voit exactement ce que vous avez facturé.',
      },
    ],
    articleSlug: 'comptes-connectes-explique',
    article: `Il existe un moment, dans la vie de toute plateforme qui réussit, où elle se met à encaisser pour le compte de ses clients et découvre qu’elle est devenue par accident une entreprise de paiement.

Les deux échappatoires habituelles sont mauvaises. Tout regrouper sur votre propre compte, et vous détenez l’argent d’autrui sans licence. Envoyer chaque client s’inscrire lui-même chez un prestataire, et vous en perdez la moitié sur un formulaire que vous ne contrôlez pas.

## Une troisième option

Créez le compte par API. Un appel, avec la raison sociale, le type et le pays, et le client possède un vrai compte marchand — ses propres portefeuilles, son profil de règlement, ses relevés et sa vérification.

Puis encaissez pour lui avec **votre** clé, en ajoutant un en-tête. Tout ce que votre clé peut faire pour vous, elle le fait pour ce compte. Vos portées s’appliquent toujours.

## Il est le marchand de référence

C’est ce qui rend le montage juridiquement sain, et pas seulement commode.

L’argent arrive dans **son** portefeuille. Il se règle selon **son** profil de règlement, vers **ses** instructions. Ses relevés sont les siens. BitriPay détient l’autorisation et reste la partie réglementée ; vous êtes un intégrateur, pas un dépositaire.

Vous ne détenez jamais son argent, donc il n’y a jamais un jour où un régulateur demande pourquoi vous le détenez.

## Votre commission est visible

Fixez une commission par défaut en points de base sur le compte, ou un montant fixe par paiement. Elle est prélevée à la capture comme un partage transparent et apparaît sur les **deux** relevés — le vôtre et le sien.

Cette visibilité est voulue. Une commission de plateforme déduite invisiblement du règlement d’un client est le genre d’arrangement qui paraît habile jusqu’à ce que le client le découvre. Celle qui apparaît comme une ligne lisible par les deux parties survit à la conversation.

## La transmission est prévue, pas négociée

Envoyez au client un lien à usage unique quand il doit posséder le compte lui-même. Il définit un mot de passe, se connecte, et vous voit dans son équipe comme administrateur.

Et alors — c’est le point important — **il peut vous retirer.** À tout moment, sans vous le demander, sans ticket de support. Ses clés, ses portefeuilles et son historique restent à lui.

Cela ressemble à une fonctionnalité contre votre intérêt. C’est l’inverse. Un client qui sait qu’il peut partir sans rien perdre est un client qui ne passe pas la relation à préparer sa sortie.

## Ses événements vous parviennent

Les paiements d’un compte connecté déclenchent des notifications vers vos points de terminaison, portant l’identifiant du compte : votre système sait de quel paiement il s’agit sans avoir à demander.

## Ce que cela coûte

Rien pour créer ou détenir des comptes. Les paiements portent le tarif habituel. Votre commission de plateforme vous revient.`,
  },

  'team-and-roles': {
    name: 'Équipe et rôles',
    tagline: 'Déléguez le comptoir, pas l’entreprise.',
    headline: 'Laisser le personnel encaisser sans livrer l’entreprise',
    excerpt:
      'Le propriétaire ne peut pas tenir le comptoir toute la journée, et confier le téléphone à un employé revient généralement à tout lui confier. Des rôles avec une limite de remboursement que le logiciel applique, et une piste d’audit qui nomme qui a fait quoi.',
    usp: 'Le personnel reçoit ses propres identifiants avec un rôle que le logiciel applique à chaque fois, y compris une limite de remboursement fixée par le propriétaire — déléguer le comptoir ne veut donc pas dire livrer l’entreprise.',
    audience: 'Toute entreprise de plus d’une personne : boutiques avec caissiers, écoles avec un guichet de frais, coopératives, ONG, plateformes avec un développeur qui n’est pas salarié.',
    problem:
      'Les petites entreprises partagent un seul identifiant parce que l’alternative est de tout faire soi-même. Un mot de passe partagé, c’est aucune idée de qui a remboursé quoi, aucun moyen de retirer un partant, et un compte de règlement que n’importe qui peut changer.',
    how: [
      'Invitez la personne par courriel ou par téléphone ; elle obtient son propre compte et se connecte en son nom.',
      'Donnez-lui un rôle : caissier, responsable financier, responsable d’exploitation, développeur, lecture seule, administrateur.',
      'Fixez la limite de remboursement du caissier pour l’organisation ; le logiciel refuse tout ce qui la dépasse.',
      'Chaque action est écrite dans la piste d’audit sous son nom, et la retirer prend effet immédiatement.',
    ],
    proof: [
      'Un caissier encaisse et rembourse jusqu’à la limite de l’organisation, et se voit refuser les instructions de règlement, les secrets d’API, les relevés, les exports de clients et la gestion des membres.',
      'Un responsable financier change les instructions de règlement et rembourse au-dessus de la limite du caissier, mais ne voit jamais les clés d’API.',
      'Un développeur gère les clés et les notifications et ne peut pas rembourser ; les clés restent à l’entreprise quand le développeur s’en va.',
      'Le propriétaire est immuable : ce rôle ne peut être retiré par personne, administrateur compris.',
      'Des unités commerciales peuvent être liées à des lieux : un paiement encaissé dans une succursale porte l’unité à laquelle il appartient.',
    ],
    cost: 'Inclus. Il n’y a aucun frais par utilisateur, et une entreprise peut inviter autant de personnes qu’il le faut.',
    faq: [
      {
        question: 'Qu’est-ce qui empêche un caissier de rembourser une vente sur son propre compte ?',
        answer:
          'Deux choses. Un remboursement renvoie l’argent au payeur du paiement d’origine, pas à une adresse choisie par le caissier ; et un caissier ne peut rembourser que jusqu’à la limite fixée par l’entreprise, au-delà de laquelle le remboursement est refusé et doit être fait par quelqu’un qui en a l’autorité.',
      },
      {
        question: 'Un employé est parti. Que dois-je changer ?',
        answer: 'Retirez-le. Cela prend effet immédiatement, et ses actions passées restent dans la piste d’audit sous son propre nom. Aucun mot de passe à changer, puisqu’il n’a jamais eu le vôtre.',
      },
      {
        question: 'Mon développeur n’est pas salarié. Puis-je lui donner un accès sans risque ?',
        answer:
          'Donnez-lui le rôle de développeur. Il gère les clés d’API et les notifications et peut créer des paiements, mais ne peut toucher ni au règlement, ni aux décaissements, ni aux exports de clients. Chaque action lui est attribuée, et les clés restent à votre entreprise après son départ.',
      },
    ],
    articleSlug: 'equipe-et-roles-explique',
    article: `Presque toutes les petites entreprises commencent avec un seul identifiant, parce que l’alternative est que le propriétaire tienne le comptoir toutes les heures d’ouverture.

Puis la boutique grandit, et le mot de passe partagé devient discrètement le plus grand risque non géré de l’entreprise.

## Ce que coûte vraiment un identifiant partagé

Vous ne pouvez pas savoir qui a remboursé la vente qui ne tombe pas juste. Vous ne pouvez pas retirer le cousin qui a travaillé deux week-ends en mars. Le compte de règlement — celui qui dit où va tout votre argent en fin de journée — peut être changé par quiconque a déjà vu le téléphone.

Rien de tout cela n’est théorique. L’identifiant partagé va très bien jusqu’à la semaine où il ne va plus du tout.

## Des rôles que le logiciel applique

Chacun a sa propre connexion et un rôle. Le rôle n’est pas une consigne affichée au mur ; il est appliqué à chaque requête.

**Un caissier** encaisse et rembourse jusqu’à une limite que vous fixez. Les instructions de règlement, les secrets d’API, les relevés, les exports de clients et la gestion des membres lui sont refusés — pas cachés, refusés.

**Un responsable financier** change les instructions de règlement et rembourse au-dessus de la limite du caissier, et ne voit jamais les clés d’API.

**Un développeur** gère les clés et les notifications et ne peut pas rembourser.

**La lecture seule** voit et ne touche à rien.

## La limite de remboursement est celle qui compte

C’est par les remboursements qu’un comptoir fuit. Fixez la limite du caissier au niveau de ce à quoi ressemble une vraie erreur dans votre boutique — une mauvaise quantité, un double scan. Tout ce qui dépasse est refusé et doit être fait par quelqu’un qui en a l’autorité.

Il vaut la peine d’être clair sur ce qu’un remboursement peut et ne peut pas faire : il renvoie l’argent au payeur du paiement d’origine. Ce n’est pas un moyen d’envoyer de l’argent à une adresse choisie par le caissier. C’est la limite **et** la destination qui, ensemble, rendent le comptoir sûr.

## Le propriétaire ne peut pas être retiré

Le rôle de propriétaire est immuable. Ni par un administrateur, ni par un autre propriétaire, ni par personne. Cela ferme le plus vieux scénario désagréable des entreprises à compte partagé : une brouille au cours de laquelle quelqu’un avec un accès verrouille tous les autres hors de l’argent.

## Les départs sont un clic

Retirez la personne. Effet immédiat. Ses actions passées restent dans la piste d’audit sous son propre nom, et c’est le but — vous gardez l’historique et perdez l’accès.

Aucun mot de passe à changer, aucune panique pour deviner ce qu’elle pouvait atteindre, puisqu’elle n’a jamais eu le vôtre.

## Les succursales

Des unités commerciales peuvent être liées à des lieux : un paiement encaissé dans une succursale porte l’unité à laquelle il appartient. Deux boutiques, un compte, et des chiffres réellement comparables.

## Ce que cela coûte

Rien par personne. Invitez autant de gens que l’entreprise en a besoin.`,
  },

  'wallets-and-transfers': {
    name: 'Portefeuilles et virements',
    tagline: 'De l’argent qui arrive à l’instant où il part.',
    headline: 'Pourquoi un virement devrait être une écriture et non deux messages',
    excerpt:
      'La plupart des virements « instantanés » sont deux systèmes qui s’envoient des messages et se rapprochent plus tard. Quand l’argent a quitté un solde sans être arrivé à l’autre, quelqu’un le détient. Sur un seul grand livre, il n’existe aucun intervalle où il pourrait séjourner.',
    usp: 'Un virement entre deux comptes est une seule écriture équilibrée dans un grand livre en partie double, pas un message entre deux systèmes qui pourraient plus tard ne pas être d’accord.',
    audience: 'Toute personne qui paie quelqu’un sur la même plateforme : familles, employeurs qui paient leur personnel, entreprises qui paient leurs fournisseurs, tontines.',
    problem:
      'Entre deux institutions, un virement est un message. L’expéditeur voit un débit, le destinataire ne voit rien, et on demande à un conseiller où est l’argent. La réponse honnête est le plus souvent « dans un fichier qui sera traité cette nuit ».',
    how: [
      'Choisissez la personne par son identifiant, son numéro de téléphone, ou en scannant son code.',
      'L’écran affiche le montant, les frais et ce qui arrivera réellement, avant tout mouvement.',
      'Validez par empreinte digitale ou code PIN.',
      'Une seule écriture débite un portefeuille et crédite l’autre ; les deux relevés l’affichent au même instant.',
    ],
    proof: [
      'Chaque mouvement est une écriture équilibrée en partie double : la somme des lignes est nulle, et une transaction qui ne s’équilibrerait pas est refusée plutôt qu’enregistrée.',
      'Les soldes sont déduits des écritures : un solde ne peut donc pas être modifié, seulement mouvementé.',
      'Une annulation est une nouvelle écriture en sens inverse, jamais une suppression : l’histoire de ce qui s’est passé reste lisible.',
      'Le grand livre est rapproché avec lui-même : chaque solde de portefeuille doit égaler la somme de ses propres écritures, et un écart déclenche une alerte au lieu d’être absorbé comme un arrondi.',
      'Les plafonds s’appliquent par compte et par palier avant l’écriture, et non après coup.',
    ],
    cost: 'Les frais sont affichés avant votre validation, avec le montant qui arrivera réellement. Il n’y a pas de second prélèvement à l’autre bout ni de retenue que l’écran n’a pas nommée.',
    faq: [
      {
        question: 'Combien de temps cela prend-il ?',
        answer:
          'Entre deux comptes BitriPay, c’est une seule écriture : le destinataire le voit au moment où l’écran de l’expéditeur confirme. Il n’existe aucune fenêtre pendant laquelle l’argent a quitté un côté sans atteindre l’autre.',
      },
      {
        question: 'Je me suis trompé de destinataire.',
        answer:
          'Un virement vers un autre compte est définitif dès son enregistrement, exactement comme remettre des espèces en main propre. C’est précisément pourquoi l’écran de confirmation affiche le nom du destinataire et pas seulement son numéro : lisez le nom avant de valider.',
      },
      {
        question: 'Qu’est-ce qui empêche quelqu’un de vider mon portefeuille ?',
        answer:
          'Rien ne sort sans votre propre empreinte ou votre code PIN, les plafonds s’appliquent par compte et par palier de vérification, et un nouveau destinataire peut exiger une vérification renforcée avant qu’un montant important ne bouge.',
      },
    ],
    articleSlug: 'portefeuilles-et-virements-explique',
    article: `« Virement instantané » veut généralement dire quelque chose de très précis et de pas très instantané : deux institutions échangent un message, chacune l’inscrit dans ses propres livres, et les deux jeux de livres sont comparés plus tard dans la nuit.

La plupart du temps, cela fonctionne. La question intéressante est ce qui se passe dans l’intervalle.

## L’intervalle

L’expéditeur voit un débit. Le destinataire ne voit rien. Quelque part entre les deux, l’argent existe dans un message plutôt que dans un compte.

Ensuite, l’une de trois choses se produit. Il arrive. Il échoue et revient, des heures plus tard. Ou il entre dans l’état que redoute tout conseiller, où un système dit envoyé et l’autre dit rien reçu, et où la résolution prend un fichier, un appel téléphonique et une semaine.

Cet intervalle n’est pas un défaut d’implémentation. C’est ce que l’on obtient quand deux jeux de livres doivent se mettre d’accord sur le même argent.

## Un seul jeu de livres

Entre deux comptes BitriPay, il n’y a qu’un grand livre. Un virement est une écriture unique : un portefeuille est débité, l’autre crédité, dans la même transaction.

Il n’existe aucun moment où l’argent est parti sans être arrivé, parce qu’il n’y a nulle part où il pourrait se trouver entre les deux.

C’est toute l’affirmation, et elle vaut exactement ce que vaut le grand livre en dessous.

## Ce qui rend ce grand livre crédible

**Chaque écriture s’équilibre.** Les lignes d’une transaction totalisent zéro, et une transaction qui ne s’équilibrerait pas est refusée plutôt qu’enregistrée. Les livres ne peuvent pas être faux par construction.

**Les soldes sont déduits, pas stockés puis modifiés.** Le solde d’un portefeuille est la somme de ses propres écritures. Personne — aucun administrateur, aucun conseiller, aucune tâche automatique à deux heures du matin — ne peut fixer un solde à un chiffre. On ne peut que l’écrire.

**Les corrections sont des écritures aussi.** Une annulation est une nouvelle ligne en sens inverse, jamais une suppression. Si quelque chose était faux puis a été corrigé, les deux faits restent dans l’historique. Un grand livre que l’on peut modifier discrètement est un grand livre auquel personne ne devrait faire confiance, vous compris.

**Il se vérifie lui-même.** Chaque solde de portefeuille doit égaler la somme de ses propres lignes. C’est rapproché, et un écart déclenche une alerte au lieu d’être absorbé comme une différence d’arrondi.

## Avant de valider

L’écran affiche le **nom** du destinataire, le montant, les frais et ce qui arrivera réellement. Lisez le nom. Un virement entre comptes est définitif dès son enregistrement, de la même façon que remettre des espèces à quelqu’un est définitif — ce qui est exactement la raison pour laquelle le nom est à l’écran et pas seulement le numéro.

## Ce que cela coûte

Les frais figurent sur l’écran de confirmation, avec le montant qui arrive. Pas de second prélèvement à l’autre bout, et rien de retenu que l’écran n’ait pas nommé.`,
  },

  'agents-and-cash': {
    name: 'Agents et espèces',
    tagline: 'Le dernier kilomètre, c’est une personne.',
    headline: 'L’argent numérique ne vaut que l’endroit où vous pouvez le retransformer en espèces',
    excerpt:
      'Un solde que vous ne pouvez pas dépenser au marché n’est pas de l’argent, c’est une promesse. Le réseau d’agents est le dernier kilomètre — et ce qui décide s’il fonctionne n’est pas l’application, c’est de savoir si l’agent a encore de la liquidité à seize heures.',
    usp: 'Dépôt et retrait d’espèces auprès d’un être humain proche de vous, avec une commission que l’application affiche avant votre validation et une liquidité que la plateforme surveille pour que l’agent ne se retrouve pas à sec au milieu de la file.',
    audience: 'Toute personne qui a besoin d’espèces en main : commerçantes de marché, familles, personnes payées en numérique qui achètent à des vendeurs qui ne le sont pas.',
    problem:
      'Un agent qui n’a plus d’espèces est pire que pas d’agent du tout, parce que le client a déjà fait le déplacement. La plupart des réseaux découvrent qu’un agent est à sec quand un client se plaint.',
    how: [
      'Trouvez un agent à proximité dans l’application, avec le montant souhaité.',
      'La commission est affichée avant votre validation : vous connaissez le coût des espèces avant de marcher.',
      'Validez par empreinte digitale ; l’agent voit la demande et le code.',
      'Les espèces changent de main quand l’application affiche le versement comme réglé — pas avant.',
    ],
    proof: [
      'La commission est affichée au client avant la confirmation au lieu d’être prélevée après coup.',
      'La liquidité d’un agent est détenue dans son propre compte du grand livre : ce que l’agent peut verser est un solde, pas une estimation.',
      'L’intelligence de liquidité observe le rythme d’activité de chaque agent et signale ceux qui se vident avant qu’un client n’arrive.',
      'Le score de confiance et la commission d’un agent découlent de comportements mesurés, pas d’une négociation agent par agent.',
      'Un versement qui échoue est annulé au grand livre : le solde du client n’est pas laissé dans un retrait qui est mort en silence.',
    ],
    cost: 'L’agent perçoit une commission que l’application affiche avant votre validation. Lorsqu’un frais de plateforme s’applique, il apparaît sur le même écran.',
    faq: [
      {
        question: 'Comment savoir si l’agent aura des espèces ?',
        answer:
          'La plateforme compare la liquidité de chaque agent au rythme de son activité et signale ceux qui s’épuisent, afin qu’un agent puisse être réapprovisionné avant que la file ne se forme, plutôt qu’après qu’un client s’y soit rendu pour rien.',
      },
      {
        question: 'Quand remettre, ou prendre, les espèces ?',
        answer:
          'Quand l’application affiche le versement comme réglé. Pas sur une capture d’écran, pas parce que l’agent affirme que c’est passé. L’état réglé est le seul reçu que l’un ou l’autre devrait accepter.',
      },
      {
        question: 'Un agent peut-il me prendre plus que ce qu’affiche l’application ?',
        answer: 'La commission à l’écran est la commission. Tout ce qui s’y ajoute ne fait pas partie du service et doit être signalé au support.',
      },
    ],
    articleSlug: 'agents-et-especes-explique',
    article: `Il y a une phrase qui décide si l’argent numérique est réel pour quelqu’un : *puis-je transformer ceci en espèces avant la fermeture du marché ?*

Si la réponse est non, le solde n’est pas de l’argent. C’est une promesse, et les promesses n’achètent pas de poisson.

## Le dernier kilomètre, c’est une personne

Sur les marchés que BitriPay sert, le dernier kilomètre n’est pas un distributeur automatique. C’est une personne avec une caisse — dans un kiosque, une pharmacie, une boutique de téléphonie — qui prend votre solde numérique et vous remet des billets, ou qui prend vos billets et crédite votre solde.

Tout ce qui concerne la technologie est en aval de la question de savoir si cette personne a des espèces à seize heures.

## Le vrai échec, c’est un agent vide

Un agent qui n’a plus d’espèces est pire que pas d’agent du tout, parce que le client a déjà fait le trajet. Il a dépensé la marche. Il se retrouve avec un solde, une histoire d’application qui ne marche pas, et pas de poisson.

La plupart des réseaux apprennent qu’un agent est à sec de la même manière : un client se plaint.

## Une liquidité que l’on voit

La liquidité d’un agent est détenue dans son propre compte du grand livre. Ce que l’agent peut verser est donc un **solde**, pas une estimation, et l’agent comme la plateforme peuvent le voir.

Par-dessus, l’intelligence de liquidité observe le rythme d’activité de chaque agent — ce qu’il verse d’habitude, quels jours, à quelles heures — et signale ceux qui se vident **avant** que la file ne se forme. On dit à l’agent de se rééquilibrer pendant qu’il en a encore le temps.

C’est une petite chose qui décide discrètement si le réseau est digne de confiance.

## La commission avant la marche

La commission est affichée au client **avant** sa confirmation, pour que le coût des espèces soit connu avant le déplacement au lieu d’être prélevé au comptoir.

La commission à l’écran est la commission. Tout ce qu’un agent demande en plus ne fait pas partie du service.

## La règle, pour les deux côtés

Les espèces changent de main quand l’application affiche le versement comme **réglé**.

Pas sur une capture d’écran. Pas sur un *c’est passé, je vous assure*. Pas sur un message venant d’un numéro inconnu. L’état réglé est le reçu, et c’est le même reçu pour le client et pour l’agent, ce qui en fait une réponse plutôt qu’une dispute.

Un versement qui échoue est annulé au grand livre, pour que le client ne se retrouve pas avec de l’argent bloqué dans un retrait mort en silence.

## Pour les agents

Un agent gagne au volume, et le score de confiance comme la commission découlent de comportements mesurés plutôt que d’une négociation au cas par cas. Gardez de la liquidité, servez les clients, et les chiffres suivent.`,
  },

  'add-money': {
    name: 'Alimenter son compte',
    tagline: 'Rien n’apparaît avant que quelque chose ne soit arrivé.',
    headline: 'Pourquoi votre solde ne bouge que lorsque l’argent a bougé',
    excerpt:
      'Le moyen le plus rapide de détruire une plateforme de paiement est de créditer un solde sur la parole d’un client. Voici ce qui doit être vrai avant qu’un chiffre monte à l’écran, et pourquoi une règle d’émission vaut mieux qu’un conseiller confiant.',
    usp: 'Une alimentation confirmée par la preuve de l’opérateur ou de la banque, pas par le client qui affirme avoir payé — pour qu’aucun solde n’apparaisse sans argent derrière.',
    audience: 'Toute personne qui met de l’argent sur un compte : clients qui rechargent, commerçants qui alimentent leur liquidité, entreprises qui chargent un portefeuille.',
    problem:
      'L’alimentation est l’endroit où vit la fraude. Une capture d’écran n’est pas un paiement, une référence tapée à la main n’est pas une preuve, et un conseiller sous pression est le point le plus faible de toute plateforme qui laisse un humain créditer un solde.',
    how: [
      'Choisissez votre mode d’alimentation : un numéro de collecte opérateur, une instruction bancaire, une carte, ou un agent.',
      'Payez comme l’instruction l’indique, en citant la référence qu’elle vous donne.',
      'La plateforme rapproche la confirmation de l’opérateur ou de la banque avec votre référence.',
      'Le solde bouge quand la preuve arrive — et le grand livre inscrit de quelle preuve il s’agissait.',
    ],
    proof: [
      'L’alimentation est rapprochée des preuves de l’opérateur ou de la banque, et une confirmation qui ne peut pas être rapprochée devient un dossier plutôt qu’un crédit.',
      'Les preuves sont dédoublonnées : la même confirmation ne peut pas servir deux fois à créditer deux soldes.',
      'La monnaie électronique ne peut pas être émise au-delà des fonds compensés et cantonnés : la règle d’émission refuse, elle n’avertit pas, quand la contrepartie n’est pas là.',
      'Chaque crédit nomme son autorité — alimentation externe, administrateur, liquidité, programme — pour qu’aucun solde n’existe sans un motif attaché.',
      'Un crédit manuel suit le principe des quatre yeux : la personne qui le propose n’est pas celle qui l’approuve.',
    ],
    cost: 'Le coût de l’alimentation dépend de la façon dont l’argent arrive ; l’écran affiche la charge avant que vous ne payiez, et un agent affiche une commission avant votre validation.',
    faq: [
      {
        question: 'J’ai payé mais mon solde n’a pas bougé.',
        answer:
          'Le crédit attend que la confirmation de l’opérateur ou de la banque soit rapprochée de votre référence. Si la référence était erronée ou absente, cela devient un dossier pour un humain plutôt qu’un crédit discret — contactez le support avec l’heure et le montant, et le rapprochement pourra être fait.',
      },
      {
        question: 'Un conseiller peut-il simplement ajouter de l’argent sur mon compte ?',
        answer:
          'Pas seul. Un crédit manuel est proposé par un administrateur et approuvé par un autre, il nomme son autorité, et il est soumis à la même règle que toute autre émission : il ne peut pas dépasser les fonds compensés qui adossent la devise.',
      },
      {
        question: 'Pourquoi ne pouvez-vous pas simplement croire ma capture d’écran ?',
        answer:
          'Parce qu’une capture d’écran se modifie en une minute par n’importe qui, et qu’une plateforme qui crédite des soldes sur cette base cesse de pouvoir adosser les soldes qu’elle a émis. Le délai pour un client honnête se compte en minutes ; l’alternative coûte à tout le monde.',
      },
    ],
    articleSlug: 'alimenter-son-compte-explique',
    article: `Toutes les plateformes de paiement qui se sont effondrées se sont effondrées au même endroit : au moment où un chiffre à l’écran est monté sans qu’aucun argent n’arrive derrière.

L’alimentation est donc la partie la moins glorieuse et la plus porteuse de tout le système.

## Une capture d’écran n’est pas un paiement

Il faut moins d’une minute pour modifier une capture d’écran de façon convaincante. Il en faut moins encore pour transférer celle de quelqu’un d’autre.

La capture ne peut donc pas être le déclencheur. Ni une référence tapée à la main dans une conversation, ni le jugement d’un conseiller à la fin d’une longue journée — non parce que les conseillers sont malhonnêtes, mais parce qu’un système où un humain fatigué peut créer de l’argent est un système qui finira par en créer par accident.

## Une preuve, rapprochée

Le solde bouge quand une **preuve** arrive de l’opérateur ou de la banque, et que cette preuve est rapprochée de la référence qui vous a été donnée.

Les preuves sont dédoublonnées : la même confirmation ne peut pas servir deux fois à créditer deux soldes différents. Une confirmation qui ne peut être rapprochée de rien ne devient pas un crédit discret — elle devient un **dossier**, qu’un humain examine avec les faits sous les yeux.

C’est la différence entre une plateforme qui fait occasionnellement attendre un client vingt minutes et une plateforme qui émet occasionnellement de l’argent qui n’existe pas.

## La règle en dessous

Il existe une règle d’émission que la plateforme applique au lieu de la surveiller :

> la monnaie électronique ne peut pas être émise au-delà des fonds compensés et cantonnés dans la même devise.

Pas un objectif. Pas un tableau de bord avec un voyant rouge. Un refus. Si la contrepartie n’est pas là, l’émission n’a pas lieu, et la personne qui essaie de la provoquer reçoit une erreur, pas un avertissement qu’elle pourrait écarter d’un clic.

## Chaque crédit a un auteur

Aucun solde n’existe sans motif attaché. Chaque crédit nomme son autorité — alimentation externe, administrateur, liquidité, programme — et cela reste dans le grand livre définitivement.

Un crédit manuel, quand il est réellement nécessaire, suit le principe des **quatre yeux** : un administrateur propose, un autre approuve. Une personne seule ne peut pas créer d’argent, phrase qui mérite d’être relue si vous avez déjà travaillé quelque part où une seule personne pouvait le faire.

## Ce que cela vous coûte, à vous le client honnête

Des minutes, parfois. Votre alimentation est confirmée quand l’opérateur ou la banque la confirme, pas quand vous l’affirmez.

Ce que vous obtenez pour ces minutes, c’est que tous les autres soldes de la plateforme sont adossés aussi — y compris, le jour où cela compte, le vôtre.`,
  },

  withdrawals: {
    name: 'Retraits et versements',
    tagline: 'Retenu, exécuté, ou rendu. Jamais perdu entre les deux.',
    headline: 'Ce qui arrive à votre argent entre « retirer » et les espèces',
    excerpt:
      'Entre le moment où vous appuyez sur retirer et l’arrivée de l’argent, votre solde doit bien être quelque part. Voici ce qu’est une retenue, pourquoi un versement important demande deux personnes, et ce qui se passe au grand livre quand un rail refuse.',
    usp: 'Un versement retenu sur votre solde dès votre demande, exécuté sous quatre yeux au-delà d’un seuil, et annulé au grand livre si le rail refuse — pour que l’argent ne soit jamais à la fois dépensé et encore dépensable.',
    audience: 'Commerçants qui encaissent leurs recettes, clients qui retirent, entreprises qui paient fournisseurs et personnel.',
    problem:
      'Si une plateforme diminue votre solde et que le versement échoue ensuite, un système vous doit de l’argent alors qu’il ne pense plus vous le devoir. Si elle ne le diminue pas, vous pouvez dépenser deux fois le même argent pendant que le versement est en vol.',
    how: [
      'Demandez le versement ; le montant est immédiatement retenu sur votre solde.',
      'Votre solde disponible baisse du montant retenu : le même argent ne peut pas être dépensé deux fois.',
      'Au-delà du seuil fixé par l’entreprise, une deuxième personne approuve avant l’exécution.',
      'En cas de succès, la retenue se règle ; en cas de refus, elle est levée et votre solde est intact.',
    ],
    proof: [
      'Une retenue réduit le solde disponible sans retirer l’argent : un versement en vol ne peut ni être dépensé à nouveau ni disparaître.',
      'Les versements au-delà du seuil configuré exigent un second approbateur ; le proposant ne peut pas approuver le sien.',
      'Un versement échoué est annulé par une écriture en sens inverse : le grand livre montre la tentative et le retour au lieu de cacher les deux.',
      'Les changements de destination sont protégés : modifier l’endroit où part l’argent du règlement est une action contrôlée, pas une modification de profil.',
      'Chaque versement porte une référence qui apparaît sur le relevé et sur la confirmation du rail lui-même.',
    ],
    cost: 'Les frais de versement sont affichés avant votre confirmation, avec le montant qui arrivera à l’autre bout.',
    faq: [
      {
        question: 'Mon versement a échoué. Où est mon argent ?',
        answer:
          'De retour dans votre solde disponible. Un versement échoué est annulé par une écriture en sens inverse, et la tentative comme le retour sont visibles sur votre relevé — vous voyez ce qui s’est passé au lieu de devoir le demander.',
      },
      {
        question: 'Pourquoi un gros versement doit-il être approuvé par quelqu’un d’autre ?',
        answer:
          'Parce que le contrôle le plus efficace contre la fraude comme contre les erreurs catastrophiques est qu’une personne seule ne puisse pas déplacer de grosses sommes. Le seuil est fixé par l’entreprise, donc les montants du quotidien ne sont pas ralentis.',
      },
      {
        question: 'Quelqu’un a changé mon compte de règlement. Comment ?',
        answer:
          'Cela ne devrait pas pouvoir se faire discrètement. Modifier l’endroit où part l’argent du règlement est une action protégée avec ses propres contrôles, distincte de la modification d’un détail ordinaire du profil, précisément parce que c’est le champ le plus précieux du compte.',
      },
    ],
    articleSlug: 'retraits-et-versements-explique',
    article: `Appuyez sur retirer et votre argent entre dans un intervalle. Il n’a pas encore atteint la banque, le portefeuille ou l’agent, mais il ne devrait pas non plus rester dans votre solde dépensable.

Ce qu’une plateforme fait de cet intervalle vous dit presque tout ce qu’il faut savoir d’elle.

## Deux façons de se tromper

**Diminuer tout de suite et espérer.** Votre solde baisse. Le rail refuse. La plateforme vous a maintenant pris de l’argent pour un versement qui n’a jamais eu lieu, et le récupérer dépend de quelqu’un qui le remarquera.

**Ne diminuer qu’en cas de succès.** Votre solde reste intact pendant que le versement est en vol — vous pouvez donc redépenser le même argent, et deux choses sont vraies en même temps, ce qui est le genre de problème qui finit dans un grand livre qui ne s’équilibre plus.

## La retenue est la troisième réponse

Quand vous demandez un versement, le montant est **retenu**.

L’argent est toujours à vous et toujours sur votre compte. Mais votre solde *disponible* baisse du montant retenu : il ne peut pas être dépensé pendant que le versement est en vol. Rien n’a été pris, et rien ne peut être dépensé deux fois.

Ensuite, exactement une de deux choses se produit :

- **Le versement réussit.** La retenue se règle en mouvement réel.
- **Le rail refuse.** La retenue est levée et votre solde disponible est intact, immédiatement.

Les deux issues sont des écritures au grand livre. La tentative et le retour sont tous deux visibles sur votre relevé, ce qui veut dire que vous pouvez voir ce qui s’est passé sans demander à personne.

## Pourquoi un versement important attend une deuxième personne

Au-delà d’un seuil fixé par l’entreprise, un versement exige un second approbateur, et la personne qui l’a proposé ne peut pas être celle qui l’approuve.

C’est le plus ancien contrôle de la finance et toujours le plus efficace, contre la fraude comme contre les erreurs coûteuses. Il ne ralentit pas le quotidien, parce que le seuil est à vous de fixer — il ralentit exactement les paiements qui méritent d’être ralentis.

## Le champ qu’il faut protéger

Le champ le plus précieux de tout compte commerçant est la destination du règlement : l’endroit où va tout l’argent en fin de journée.

Le modifier est une action protégée avec ses propres contrôles, pas une modification de profil ordinaire. Un attaquant qui entre dans un compte ne devrait pas pouvoir rediriger les revenus de l’entreprise en tapant un nouveau numéro de compte.

## Ce que cela coûte

Les frais sont affichés avant votre confirmation, avec le montant qui arrivera réellement.`,
  },

  remittance: {
    name: 'Transferts vers le pays',
    tagline: 'Le chiffre à l’écran est le chiffre qu’ils reçoivent.',
    headline: 'Le vrai coût d’un envoi au pays, c’est le taux, pas les frais',
    excerpt:
      'Tout le monde compare les frais de transfert. Presque personne ne compare le taux de change, où part pourtant l’essentiel de l’argent. Une cotation avec une échéance et une marge énoncée rend la comparaison possible.',
    usp: 'Un taux coté et bloqué pendant toute la durée de validité de la cotation, avec la marge indiquée en points de base — pour que la famille à l’autre bout reçoive le chiffre qu’on vous a montré, et non ce que le taux est devenu.',
    audience: 'La diaspora qui envoie de l’argent au pays, et les familles qui le reçoivent.',
    problem:
      'Un service annonce des frais faibles et se rattrape sur un taux que l’expéditeur ne voit jamais coté face à une référence. La famille reçoit moins que prévu et personne ne peut dire précisément pourquoi.',
    how: [
      'Demandez une cotation : combien vous envoyez, dans quelle devise, vers quelle destination.',
      'La cotation affiche le taux, le taux médian dont il est issu, la marge en points de base, les frais et le montant exact qui arrivera.',
      'Elle porte une échéance. Payez dans ce délai et c’est ce taux qui s’applique.',
      'Si vous payez après expiration, vous êtes recoté ou remboursé — jamais converti en silence à un autre taux.',
    ],
    proof: [
      'Une cotation porte son taux, le taux médian qui le sous-tend et la marge en points de base : le coût de la conversion est un chiffre et non une impression.',
      'Les cotations ont une échéance, et un paiement contre une cotation expirée est recoté ou remboursé au lieu d’être converti à ce que le taux est devenu.',
      'Le montant qui arrive est affiché dans la devise du destinataire avant que l’expéditeur ne s’engage.',
      'Chaque corridor inscrit sa base réglementaire et ses partenaires, et seul un corridor qu’un administrateur a marqué actif peut porter des fonds réels de clients.',
      'Les conversions enregistrées emportent leur marge dans le grand livre : le vrai coût d’un corridor est mesurable plutôt qu’estimé.',
    ],
    cost: 'Deux chiffres, tous deux cotés d’avance : les frais, et la marge sur le taux de change en points de base. Le montant qui arrive est affiché avant que vous ne payiez.',
    faq: [
      {
        question: 'Pourquoi le taux médian importe-t-il ?',
        answer:
          'Le taux médian est la référence contre laquelle la marge se mesure. Sans lui, un taux n’est qu’un chiffre et vous ne pouvez pas distinguer un bon d’un mauvais. Avec lui, le coût de la conversion est explicite et vous pouvez comparer correctement les services.',
      },
      {
        question: 'Et si le taux bouge pendant que je paie ?',
        answer:
          'Votre cotation est bloquée pendant toute sa durée de validité. Payez dans ce délai et c’est ce taux. Payez après expiration et vous êtes recoté ou remboursé — vous n’êtes jamais converti en silence à un taux que vous n’avez pas accepté.',
      },
      {
        question: 'Qui détient réellement l’argent en chemin ?',
        answer:
          'Chaque corridor inscrit sa base réglementaire et les partenaires des deux côtés. Un corridor ne porte des fonds réels de clients qu’une fois qu’un administrateur l’a marqué actif au regard de ces éléments, étape délibérément lente et documentée.',
      },
    ],
    articleSlug: 'transferts-vers-le-pays-explique',
    article: `Demandez à quelqu’un combien coûte un envoi d’argent au pays et il vous donnera les frais. Trois euros. Cinq dollars. Un montant fixe sur une affiche.

Les frais sont rarement là où part l’argent.

## Où il part réellement

Imaginez deux services. L’un facture des frais fixes et convertit à un taux à deux pour cent du marché. L’autre facture davantage en frais et convertit à un taux à un demi pour cent.

Sur tout montant qui n’est pas minuscule, celui dont les frais sont plus élevés est le moins cher — souvent nettement. Mais les affiches comparent les frais, donc la comparaison que les gens font réellement est la mauvaise.

Ce n’est pas un accident. Les frais sont le chiffre sur l’affiche précisément parce que c’est le chiffre qu’on peut faire paraître petit.

## Une cotation qui montre son calcul

Une cotation BitriPay porte quatre choses :

- **Le taux** qui vous est accordé.
- **Le taux médian** dont il est issu — la référence.
- **La marge**, en points de base, entre les deux.
- **Les frais**, et le **montant exact** qui arrivera dans la devise du destinataire.

La marge est la plus importante. Elle transforme « le taux », chiffre que vous ne pouvez pas évaluer, en un coût comparable à celui de n’importe qui d’autre — s’il accepte de donner le sien.

## La cotation expire, et c’est une qualité

Chaque cotation porte une échéance.

Payez dans ce délai et ce taux s’applique, quoi qu’ait fait le marché entre-temps. Payez après expiration et vous êtes **recoté ou remboursé** — jamais converti en silence à ce que le taux est devenu.

C’est cette dernière clause qui compte. La reconversion silencieuse, c’est ainsi qu’un expéditeur finit par expliquer à sa mère pourquoi il est arrivé moins que promis, sans aucun moyen de savoir pourquoi.

## Qui le détient en chemin

Chaque corridor inscrit sa base réglementaire et les partenaires des deux côtés — qui collecte, qui verse, sous quelle autorisation.

Un corridor ne porte des fonds réels de clients qu’une fois qu’un administrateur l’a marqué actif au regard de ces éléments. Cette étape est délibérément lente et délibérément documentée, parce qu’un corridor qui tourne sans réponse claire à la question *sous quelle licence sommes-nous* est un corridor par lequel personne ne devrait faire passer l’argent de sa famille.

## Ce qu’il faut demander à n’importe quel service

Trois questions, et vous saurez l’essentiel :

1. Quel est votre taux médian, et quelle est votre marge dessus ?
2. Combien de temps la cotation est-elle bloquée, et que se passe-t-il si je paie en retard ?
3. Qui est autorisé à chaque bout de ce corridor ?

Un service incapable de répondre à la première y répond quand même.`,
  },

  exchange: {
    name: 'Change de devises',
    tagline: 'Un taux que l’on peut auditer, pas seulement accepter.',
    headline: 'Une conversion de devises devrait laisser une trace vérifiable',
    excerpt:
      'Détenir deux devises est normal ici. Ce qui ne l’est pas, c’est de pouvoir voir après coup exactement ce que chaque conversion vous a coûté. Deux volets liés et une marge énoncée le rendent possible.',
    usp: 'Une conversion cotée face à un taux médian publié avec la marge en points de base, enregistrée au grand livre en deux volets liés pour que le coût de chaque conversion reste mesurable après coup.',
    audience:
      'Toute personne qui détient plus d’une devise : commerçants qui achètent du stock à l’étranger, familles qui reçoivent dans une devise et dépensent dans une autre, entreprises qui facturent en USD et paient en CDF.',
    problem:
      'Une conversion apparaît d’habitude sur un relevé comme une seule ligne avec un nouveau montant dedans. Le taux a disparu, la référence a disparu, et il n’existe aucun moyen de savoir plus tard si c’était un bon taux.',
    how: [
      'Demandez une cotation entre les deux devises et pour le montant voulu.',
      'La cotation affiche le taux, le taux médian, la marge en points de base et le montant obtenu.',
      'Approuvez-la, et la conversion s’enregistre en deux volets liés : une vente dans une devise et un achat dans l’autre.',
      'Les deux volets portent la cotation : le relevé s’explique encore tout seul un an plus tard.',
    ],
    proof: [
      'Une conversion est deux écritures liées par une seule cotation, jamais une ligne unique contenant un nouveau chiffre.',
      'La marge voyage dans le grand livre avec l’écriture : le coût des conversions est un montant que l’on peut additionner plutôt qu’une impression.',
      'Les taux proviennent d’instantanés de fournisseurs versionnés : le taux utilisé à un instant donné peut être reproduit après coup.',
      'Une cotation a une échéance, et une cotation expirée est recotée plutôt qu’appliquée.',
    ],
    cost: 'La marge, en points de base, affichée sur la cotation avant votre approbation. Il n’y a pas de frais de conversion séparé caché dans le taux.',
    faq: [
      {
        question: 'Pourquoi le relevé affiche-t-il deux lignes pour une conversion ?',
        answer:
          'Parce que c’est ce qu’est une conversion : l’argent quitte une devise et arrive dans une autre. Deux volets liés gardent les livres des deux devises justes et gardent le taux attaché au mouvement, pour que la ligne s’explique encore plus tard.',
      },
      {
        question: 'Puis-je voir quel taux j’ai eu le mois dernier ?',
        answer:
          'Oui. La cotation est conservée avec l’écriture, y compris le taux médian et la marge, et les instantanés de taux sont versionnés : le taux en vigueur à ce moment-là peut être reproduit.',
      },
      {
        question: 'Y a-t-il des frais en plus de la marge ?',
        answer: 'La marge sur la cotation est le coût. Lorsqu’un frais séparé s’applique, il est affiché sur le même écran avant votre approbation.',
      },
    ],
    articleSlug: 'change-de-devises-explique',
    article: `À Kinshasa, détenir deux devises n’a rien d’exotique. Les prix sont annoncés en dollars, la monnaie revient en francs, et tout le monde fait des calculs de tête toute la journée.

Ce qui est plus difficile, c’est de découvrir après coup ce que ces calculs ont coûté.

## Le problème de la ligne unique

Sur la plupart des relevés, une conversion est une ligne. De l’argent est entré dans une devise et ressorti dans une autre, et la seule chose inscrite est le résultat.

Le taux a disparu. La référence a disparu. Six semaines plus tard, quand vous essayez de savoir si vos paiements fournisseurs mangent votre marge, le relevé ne peut pas vous le dire — parce que l’information n’a jamais été écrite.

## Deux volets, une cotation

Une conversion s’enregistre ici en **deux volets liés** : une vente dans la devise que vous quittez et un achat dans la devise où vous entrez, reliés par la cotation qui les a valorisés.

Cela garde les livres des deux devises justes — c’est la raison technique — mais cela garde aussi le **taux attaché au mouvement**, ce qui est la raison qui compte pour vous.

## La marge entre dans le grand livre

La cotation porte le taux, le taux médian dont il est issu, et la marge entre les deux en points de base. Quand la conversion s’enregistre, la marge part avec elle.

Cela ressemble à du pédantisme comptable. C’est la différence entre ces deux phrases :

- *« Je crois que nous perdons quelque chose sur les conversions. »*
- *« Nous avons converti 48 000 dollars le trimestre dernier à une marge moyenne de 61 points de base, ce qui a coûté 293 dollars. »*

Une seule des deux vous permet d’y faire quelque chose.

## Des taux reproductibles

Les taux proviennent d’instantanés de fournisseurs versionnés. Le taux en vigueur à un instant donné peut être reproduit après coup, au lieu d’être un chiffre qui a existé une fois puis a changé.

S’il faut expliquer une conversion à un auditeur, à un partenaire ou à un associé qui pense avoir été lésé, la réponse existe.

## Les cotations expirent

Une cotation a une échéance et est honorée dans ce délai. Une cotation expirée est recotée, pas appliquée à ce que le taux est devenu depuis. Vous n’êtes jamais converti à un prix que vous n’avez pas vu.

## Ce que cela coûte

La marge sur la cotation, en points de base, avant votre approbation. Pas de frais séparé enfoui dans le taux.`,
  },

  ledger: {
    name: 'Le grand livre',
    tagline: 'Des livres que l’on ne peut pas modifier en silence.',
    headline: 'La partie d’une plateforme de paiement que personne ne vend et dont tout le monde dépend',
    excerpt:
      'Les fonctionnalités sont ce que vous achetez. Le grand livre est ce qui décide si l’on peut leur faire confiance. Des écritures équilibrées, des soldes déduits, des annulations plutôt que des modifications, et des invariants qui refusent au lieu d’avertir.',
    usp: 'Un grand livre en partie double où les soldes sont déduits des écritures au lieu d’être stockés, où les corrections sont des écritures en sens inverse et non des modifications, et où les invariants sont appliqués à l’écriture au lieu d’être vérifiés par une tâche nocturne.',
    audience: 'Services financiers, auditeurs, régulateurs, et toute entreprise dont les livres doivent survivre à une question.',
    problem:
      'Beaucoup de systèmes gardent un solde comme un nombre et le mettent à jour. Dès qu’un solde peut être fixé au lieu d’être mouvementé, les livres cessent d’être une preuve et deviennent une opinion que quiconque a accès à la base de données peut réviser.',
    how: [
      'Chaque mouvement d’argent est une transaction composée de lignes.',
      'Les lignes d’une transaction totalisent zéro par devise ; une transaction qui ne s’équilibrerait pas est refusée, pas enregistrée.',
      'Un solde est la somme des lignes de son portefeuille — déduit, jamais stocké puis modifié.',
      'Une correction est une nouvelle transaction en sens inverse : l’erreur et sa correction restent toutes deux visibles.',
    ],
    proof: [
      'Les écritures sont équilibrées par devise au moment de l’écriture ; une transaction déséquilibrée est refusée plutôt qu’enregistrée puis corrigée.',
      'Le rapprochement recalcule chaque solde de portefeuille à partir de ses lignes et signale tout écart, au lieu de faire confiance au chiffre stocké.',
      'Les annulations sont des écritures en sens inverse ; rien n’est supprimé, l’histoire de ce qui s’est passé reste lisible.',
      'Les invariants Guardian surveillent des états qui devraient être impossibles — comme un paiement capturé sans écriture — et peuvent arrêter la plateforme plutôt que de continuer par-dessus.',
      'Chaque changement d’état est écrit dans un journal d’événements chaîné par empreinte : on peut démontrer que l’enregistrement n’a pas été réécrit après coup.',
    ],
    cost: 'Inclus. Ce n’est pas tant une fonctionnalité que le sol sur lequel tout le reste se tient.',
    faq: [
      {
        question: 'Un administrateur peut-il changer mon solde ?',
        answer:
          'Il peut l’écrire, avec une autorité enregistrée et — pour une émission — un second administrateur qui approuve. Il ne peut pas le fixer à un chiffre, parce qu’un solde n’est pas stocké comme un nombre : c’est la somme de ses propres écritures.',
      },
      {
        question: 'Que se passe-t-il quand quelque chose ne va vraiment pas ?',
        answer:
          'Une transaction corrective est enregistrée en sens inverse. L’originale reste. Quiconque lira l’historique plus tard verra l’erreur et la correction, ce qui fait des livres une preuve plutôt qu’un récit.',
      },
      {
        question: 'Qu’est-ce qu’un arrêt Guardian ?',
        answer:
          'Un invariant surveille des états qui devraient être impossibles. Si l’un apparaît, la plateforme peut s’arrêter plutôt que continuer à traiter par-dessus une contradiction. S’arrêter coûte cher ; continuer sur des livres faux coûte infiniment plus.',
      },
    ],
    articleSlug: 'le-grand-livre-explique',
    article: `Personne ne choisit une plateforme de paiement pour son grand livre. Tout le monde en dépend.

C’est la partie qui décide si l’on peut faire confiance à toutes les autres fonctionnalités, et c’est presque jamais la partie dont on parle.

## L’erreur du solde stocké

Énormément de systèmes gardent un solde dans une colonne. Un paiement arrive, la colonne monte. Un versement part, la colonne descend.

Cela marche jusqu’à ce que quelque chose l’interrompe à mi-chemin, que deux choses la mettent à jour en même temps, ou que quelqu’un avec un accès à la base de données décide d’aider. Et dès qu’un solde peut être **fixé** au lieu d’être **mouvementé**, les livres ont cessé d’être une preuve. Ils sont devenus une opinion, celle de la dernière personne à avoir eu un droit d’écriture.

## Déduit, pas stocké

Ici, un solde est la somme des lignes de son propre portefeuille. Il est calculé, pas conservé.

Cette seule décision supprime une catégorie entière de problèmes. Il n’y a aucun nombre qui puisse dériver, aucun nombre à corriger, et aucun moyen d’attribuer une valeur à un solde. On ne peut que l’écrire — et une écriture doit s’équilibrer.

## Équilibré à l’écriture

Chaque transaction est composée de lignes qui totalisent zéro par devise. Une transaction qui ne s’équilibrerait pas est **refusée**, pas enregistrée puis nettoyée plus tard.

Les livres ne peuvent pas se déséquilibrer, non parce qu’une tâche les vérifie chaque nuit, mais parce qu’un état déséquilibré n’est pas une chose qui puisse s’écrire.

## Les corrections sont des écritures

Quand quelque chose est réellement faux, la correction est une nouvelle transaction en sens inverse. L’originale reste exactement où elle était.

Quiconque lira l’historique plus tard voit les deux : ce qui s’est passé, et ce qui a été fait. Un grand livre dont on peut faire disparaître les erreurs est un grand livre auquel personne ne devrait faire confiance — y compris ceux qui le tiennent, car ils perdent la capacité de prouver leur propre bonne foi.

## Il se vérifie lui-même

Le rapprochement recalcule chaque solde à partir de ses lignes et signale les écarts. Il ne fait pas confiance au chiffre stocké, parce qu’il n’y a aucun chiffre stocké à qui faire confiance.

Au-dessus se trouvent les invariants — des affirmations sur des choses qui ne devraient jamais être vraies, comme un paiement capturé sans écriture. Si l’une devient vraie, la plateforme peut **s’arrêter** plutôt que continuer à traiter par-dessus une contradiction.

S’arrêter coûte cher. Continuer à traiter sur des livres faux est le genre de coût qui tue des entreprises.

## Et il est chaîné par empreinte

Chaque changement d’état entre dans un journal d’événements où chaque entrée est chaînée à la précédente. On peut démontrer que l’enregistrement n’a pas été réécrit après coup — ce qui est la vraie question d’un auditeur quand il demande la piste d’audit.

## Ce que cela coûte

Rien. C’est le sol, pas une fonctionnalité.`,
  },

  'settlement-and-statements': {
    name: 'Règlements et relevés',
    tagline: 'Savoir ce qui a été prélevé, pas seulement ce qui est arrivé.',
    headline: 'Un montant net n’est pas un relevé',
    excerpt:
      'La plupart des commerçants apprennent ce qu’un paiement leur a coûté en soustrayant ce qui est arrivé de ce qu’ils ont facturé. Des lignes distinctes pour les frais du prestataire, les frais de plateforme et la taxe dessus transforment cette devinette en comptabilité.',
    usp: 'Un relevé de règlement numéroté, empreinté et reproductible, qui montre les frais du prestataire, les frais de plateforme et la taxe dessus en lignes distinctes plutôt qu’en un seul montant net.',
    audience: 'Commerçants, services financiers, comptables et quiconque doit déclarer quelque chose à partir de ce que la plateforme lui a versé.',
    problem:
      'Quand un règlement arrive sous forme d’un seul montant net, le commerçant ne peut pas voir ce qui a été prélevé ni par qui, ne peut pas le rapprocher de ses propres ventes, et ne peut pas produire la ventilation fiscale dont son comptable a besoin.',
    how: [
      'Définissez un profil de règlement par devise et par rail : la fréquence, l’heure de coupure, la destination et un minimum.',
      'Un cycle rassemble ce qui a été encaissé entre deux coupures, net de frais, remboursements, répartitions et retenues.',
      'Le cycle se clôture en une obligation et un relevé numéroté.',
      'Le paiement de l’obligation passe par le circuit de versement avec ses approbations.',
    ],
    proof: [
      'Les relevés sont numérotés en séquence et empreintés, et sont produits en JSON, CSV ou PDF à partir des mêmes chiffres.',
      'Les frais du prestataire, les frais de plateforme et la taxe sur ces frais sont des lignes distinctes, pas une seule retenue nette.',
      'Lorsque la devise de règlement diffère de la devise d’encaissement, la conversion est divulguée avec son taux, son taux médian et sa marge.',
      'Un cycle peut être prévisualisé avant sa clôture : un commerçant voit ce que contiendra le prochain règlement.',
      'Les fréquences s’appliquent par profil — jour même, lendemain, deux jours, hebdomadaire ou manuel — au lieu d’un seul rythme pour tout le monde.',
    ],
    cost: 'Le règlement lui-même n’est pas facturé séparément ; les frais affichés sur le relevé sont les frais des paiements qu’il couvre.',
    faq: [
      {
        question: 'Pourquoi la taxe sur les frais est-elle une ligne distincte ?',
        answer:
          'Parce que votre comptable en a besoin séparément et que l’on ne récupère pas ce que l’on ne peut pas identifier. Une retenue nette oblige quelqu’un à reconstituer la taxe, en général de travers.',
      },
      {
        question: 'Puis-je voir le prochain règlement avant sa clôture ?',
        answer:
          'Oui. Un profil peut être prévisualisé : il affiche les totaux en devise d’encaissement avec les lignes de frais et, si les devises diffèrent, la conversion avec son taux et sa marge.',
      },
      {
        question: 'À quoi sert l’empreinte d’un relevé ?',
        answer:
          'Elle permet de démontrer qu’un relevé n’a pas été modifié depuis son émission. Combinée à la numérotation séquentielle, elle rend aussi évident un relevé manquant, ce qui compte plus qu’il n’y paraît pendant un audit.',
      },
    ],
    articleSlug: 'reglements-et-releves-explique',
    article: `Demandez à un commerçant ce que lui coûtent ses paiements et la plupart feront le même calcul à voix haute : *eh bien, j’ai facturé tant, il est arrivé tant, donc…*

Cette soustraction n’est pas de la comptabilité. C’est une estimation déguisée en fait, et elle ne peut être ni déclarée, ni récupérée, ni contestée.

## Ce qu’un montant net cache

Un règlement net unique cache au moins trois choses différentes : ce que le prestataire a gardé, ce que la plateforme a gardé, et la taxe appliquée aux frais de la plateforme.

Ces trois choses ne sont pas interchangeables. L’une est peut-être négociable. L’une est peut-être récupérable. L’une appartient à une déclaration fiscale. Fondues en une seule retenue, aucune n’est exploitable, et votre comptable finit par reconstituer un chiffre qu’il se trompera probablement à calculer.

## Des lignes distinctes

Un relevé BitriPay affiche les **frais du prestataire**, les **frais de plateforme** et la **taxe sur ces frais** en lignes distinctes.

Et lorsque l’argent a été réglé dans une devise différente de celle d’encaissement, la conversion est également divulguée — le taux, le taux médian derrière lui, et la marge. La chose la plus susceptible de vous coûter discrètement le plus est celle qui est énoncée le plus explicitement.

## Numéroté et empreinté

Les relevés sont numérotés en séquence et empreintés.

La numérotation rend un relevé manquant évident. L’empreinte permet de démontrer qu’un relevé n’a pas été modifié depuis son émission. Les deux comptent pendant un audit, et ni l’une ni l’autre ne peut être ajoutée après coup si la plateforme ne l’a pas fait sur le moment.

Les mêmes chiffres produisent du JSON, du CSV ou du PDF — un pour votre système, un pour votre tableur, un pour la personne qui veut un document.

## Votre rythme, pas le nôtre

Un profil de règlement est défini par devise et par rail : la fréquence — jour même, lendemain, deux jours, hebdomadaire ou manuel — l’heure de coupure, la destination, et un minimum en dessous duquel il attend.

Une boutique très active qui règle chaque jour et un projet qui règle chaque semaine sont des entreprises différentes et ne devraient pas être forcées au même calendrier.

## Prévisualiser avant la clôture

Un profil peut être prévisualisé. Avant la clôture du cycle, vous voyez ce que contiendra le prochain règlement : les totaux en devise d’encaissement, les lignes de frais, et la conversion s’il y en a une.

Les surprises dans un règlement sont presque toujours désagréables, et presque toujours évitables.

## Le versement

La clôture d’un cycle crée une obligation. La payer passe par le circuit de versement avec ses propres approbations — les mêmes contrôles que tout autre mouvement d’argent sortant de la plateforme.

## Ce que cela coûte

Le règlement n’est pas facturé séparément. Les frais du relevé sont les frais des paiements qu’il couvre, et vous pouvez désormais les voir.`,
  },

  'emoney-and-safeguarding': {
    name: 'Monnaie électronique et cantonnement',
    tagline: 'Chaque solde est adossé, par construction.',
    headline: 'Ce qui se tient derrière le chiffre de votre compte',
    excerpt:
      'Un solde est une créance sur quelqu’un. Que cette créance vaille quelque chose dépend de règles que personne ne voit. Voici la règle, l’endroit où l’argent se trouve, et ce qui se passe chaque jour pour prouver qu’il y est toujours.',
    usp: 'Une règle d’émission sur laquelle la plateforme refuse au lieu de rapporter : la monnaie électronique ne peut pas être émise au-delà des fonds compensés et cantonnés, vérifié au moment de l’émission et non à la fin du mois.',
    audience: 'Les clients qui veulent savoir que leur argent est réel, et les régulateurs, partenaires et auditeurs à qui il faut le démontrer.',
    problem:
      'Les défaillances de monnaie électronique ne commencent généralement pas par un vol. Elles commencent par des soldes qui ne sont pas intégralement adossés, personne qui ne s’en aperçoit pendant des mois, et un rapprochement qui était un rapport plutôt qu’un contrôle.',
    how: [
      'Chaque devise a un programme qui nomme l’émetteur légal et le dispositif de cantonnement.',
      'Les fonds ne sont enregistrés comme compensés que lorsqu’ils ont réellement été compensés.',
      'L’émission est refusée si elle dépasserait les fonds compensés, déduction faite des remboursements en attente et de l’exposition réservée.',
      'Un contrôle quotidien compare ce qui est dû aux clients avec ce qui est réellement détenu, et un déficit est comblé le jour même.',
    ],
    proof: [
      'La règle d’émission est appliquée au point d’émission, pas rapportée après coup : elle refuse au lieu d’avertir.',
      'Deux rapprochements tournent chaque jour, séparément — interne (chaque portefeuille contre ses propres écritures) et externe (l’exigence contre les comptes désignés) — parce qu’ils échouent pour des raisons différentes.',
      'Un déficit est comblé sur fonds propres le jour même, via le principe des quatre yeux existant sur les mouvements de réserve.',
      'Un dossier de résolution est généré chaque jour et chaîné par empreinte : chaque détenteur, son solde, les comptes derrière lui et la procédure de restitution de l’argent.',
      'Les soldes sont de la monnaie électronique, une créance remboursable sur l’émetteur agréé — pas un dépôt bancaire, et le produit le dit au lieu de laisser croire autre chose.',
    ],
    cost: 'Ce n’est pas une fonctionnalité facturable. C’est la condition à laquelle les soldes existent tout court.',
    faq: [
      {
        question: 'Mon solde est-il un dépôt bancaire ?',
        answer:
          'Non, et quiconque vous dit le contraire se trompe d’une manière qui compte. C’est de la monnaie électronique : une créance remboursable sur l’émetteur agréé, adossée à des fonds cantonnés détenus à cette fin. Elle n’est pas couverte par une garantie des dépôts et ne produit pas d’intérêts.',
      },
      {
        question: 'Qu’est-ce qu’un dossier de résolution ?',
        answer:
          'Le document qu’un administrateur utiliserait pour restituer les fonds des clients si l’entreprise cessait son activité : chaque détenteur, son solde, les comptes derrière lui et la procédure. Il est régénéré chaque jour et chaîné par empreinte : il est donc à jour et on peut démontrer qu’il n’a pas été modifié.',
      },
      {
        question: 'Que se passe-t-il en cas de déficit ?',
        answer:
          'Il est comblé sur fonds propres le jour même, et la correction passe par le même contrôle à deux personnes que tout autre mouvement de réserve. Le contrôle quotidien bloque les mises en production plutôt que de donner un avis — un déficit arrête les choses au lieu d’apparaître dans un rapport.',
      },
    ],
    articleSlug: 'monnaie-electronique-et-cantonnement-explique',
    article: `Le chiffre de votre compte est une créance sur quelqu’un. Qu’elle vaille ce qu’elle annonce dépend entièrement de règles que vous ne verrez jamais fonctionner.

Les voici donc.

## Ce n’est pas un dépôt bancaire

Soyons précis, parce que la version imprécise est celle par laquelle les gens se font mal.

Votre solde est de la **monnaie électronique** : une créance remboursable sur l’émetteur agréé, adossée à des fonds cantonnés à cette fin. Ce n’est pas un dépôt bancaire. Ce n’est pas couvert par une garantie des dépôts. Cela ne produit pas d’intérêts.

Quiconque vous dit le contraire est soit confus, soit en train de vendre quelque chose.

## Comment les établissements de monnaie électronique échouent réellement

Rarement par vol. Le schéma est plus terne et beaucoup plus courant : des soldes qui ne sont pas tout à fait intégralement adossés, un écart que personne ne remarque parce que le rapprochement est un rapport mensuel plutôt qu’un contrôle, puis un événement — une vague de remboursements, un partenaire qui tombe — qui transforme un écart discret en insolvabilité.

Tout cela est évitable, et rien de tout cela n’est évité par les bonnes intentions.

## Une règle qui refuse

> La monnaie électronique ne peut pas être émise au-delà des fonds compensés et cantonnés dans la même devise, déduction faite des remboursements en attente et de l’exposition réservée.

Cette règle est appliquée **au moment de l’émission**. Ce n’est pas un objectif, un tableau de bord ou un rapport mensuel. Si la contrepartie n’est pas là, l’émission n’a pas lieu et la personne qui la tente reçoit une erreur.

Notez *compensés*. L’argent promis, en transit, ou attendu demain, ne compte pas. Seul l’argent réellement arrivé adosse quelque chose.

## Deux rapprochements, quotidiens, tenus séparés

Ils sont tenus séparés parce qu’ils échouent pour des raisons complètement différentes.

**Interne :** chaque solde de portefeuille client doit égaler la somme de ses propres écritures. Une défaillance ici est un défaut dans les livres eux-mêmes — un problème d’ingénierie.

**Externe :** ce qui est dû aux clients doit égaler ce qui est réellement détenu sur les comptes désignés. Une défaillance ici, c’est de l’**argent** — un problème de trésorerie.

Faites-les tourner ensemble et vous apprenez que quelque chose va mal. Faites-les tourner séparément et vous savez quoi.

Un déficit est comblé sur fonds propres **le jour même**, via le même contrôle à deux personnes que tout autre mouvement de réserve. Et le contrôle quotidien bloque les mises en production : un déficit arrête les choses, au lieu d’apparaître dans un rapport que quelqu’un lit le vendredi.

## Le dossier du pire jour

Chaque jour, un dossier de résolution est généré : chaque détenteur, son solde, les comptes qui se tiennent derrière ces soldes, et la procédure de restitution de l’argent.

Il est chaîné par empreinte à celui de la veille : on peut démontrer qu’il n’a pas été modifié après coup.

Il décrit le jour dont personne ne veut. L’avoir prêt, à jour et infalsifiable, c’est la différence entre une restitution ordonnée des fonds et une longue dispute coûteuse menée dans le noir.

## Ce que cela coûte

Rien. C’est la condition à laquelle les soldes existent tout court.`,
  },

  'kyc-and-identity': {
    name: 'Identité et paliers',
    tagline: 'Commencez avec un téléphone. Grandissez vers les plafonds.',
    headline: 'La vérification d’identité devrait être une échelle, pas un mur',
    excerpt:
      'Exiger un dossier complet avant que quiconque puisse recevoir un seul paiement exclut précisément les personnes que l’argent numérique devait atteindre. Les paliers permettent de commencer petit et de se vérifier à mesure que les montants grandissent.',
    usp: 'Des paliers qui permettent à quelqu’un de démarrer avec un numéro de téléphone et de grandir vers des plafonds plus élevés : la vérification est une échelle plutôt qu’un mur à l’entrée.',
    audience: 'Toute personne qui ouvre un compte, et les équipes de conformité qui doivent assumer la décision de le lui permettre.',
    problem:
      'Beaucoup de gens sur les marchés que BitriPay sert n’ont pas le document qu’un formulaire exige, le jour où il l’exige. Une plateforme qui réclame tout d’emblée ne les sert simplement pas — tandis qu’une plateforme qui ne réclame rien ne peut pas fonctionner légalement.',
    how: [
      'Ouvrez au palier le plus bas avec un numéro de téléphone, et recevez dans les plafonds de ce palier.',
      'Ajoutez une pièce d’identité pour monter d’un palier et débloquer des plafonds plus élevés.',
      'Ajoutez l’adresse et l’origine des fonds pour le palier le plus haut.',
      'Les plafonds s’appliquent par palier au moment de la transaction, pas en révision après coup.',
    ],
    proof: [
      'Les plafonds par palier et par corridor sont de la configuration et non du code : ils bougent quand une règle bouge.',
      'Une transaction au-delà du plafond d’un palier est refusée avec un motif lisible nommant le palier, pas retenue en silence.',
      'Le filtrage tourne contre les listes officielles de sanctions à l’entrée en relation puis chaque jour, pas une seule fois à l’inscription.',
      'La vérification d’entreprise contrôle le registre, les bénéficiaires effectifs au-delà du seuil déclaré et les dirigeants, et attribue un palier de risque qui est revu.',
      'Chaque décision de vérification est enregistrée avec son auteur : le dossier peut être lu plus tard sans être reconstitué.',
    ],
    cost: 'La vérification est gratuite. Les paliers supérieurs débloquent des plafonds plus élevés, pas des tarifs plus bas.',
    faq: [
      {
        question: 'Pourquoi ne puis-je pas envoyer ce que je veux tout de suite ?',
        answer:
          'Parce que les plafonds qui s’appliquent à un compte non vérifié sont la condition à laquelle un compte non vérifié peut exister. Se vérifier vous fait monter d’un palier et les plafonds montent avec vous — en général en quelques minutes.',
      },
      {
        question: 'Je n’ai pas le document que vous demandez.',
        answer:
          'Vous pouvez tout de même ouvrir un compte et recevoir dans les plafonds du palier le plus bas. C’est tout l’intérêt des paliers : un document manquant limite ce que vous pouvez faire, au lieu de vous empêcher de commencer.',
      },
      {
        question: 'À quelle fréquence vérifiez-vous les listes de sanctions ?',
        answer:
          'À l’entrée en relation puis chaque jour, contre les listes consolidées officielles. Un client qui se retrouve listé après son inscription est trouvé par le réexamen quotidien, pas par hasard.',
      },
    ],
    articleSlug: 'identite-et-paliers-explique',
    article: `Toutes les équipes de conformité ont connu la même dispute. Le commerce dit que le formulaire leur coûte des clients. La conformité dit que le formulaire est ce qui garde la licence. Les deux ont raison, et c’est pourquoi la dispute ne finit jamais.

Les paliers y mettent fin.

## Le mur à l’entrée

Une plateforme qui exige un dossier complet avant que quiconque puisse recevoir un seul paiement a fait un choix, qu’elle s’en rende compte ou non : elle ne servira pas les gens qui n’ont pas ce document aujourd’hui.

Sur les marchés où BitriPay opère, ce n’est pas un petit groupe. C’est souvent le groupe que l’argent numérique devait atteindre — la commerçante, le livreur, la personne dont la pièce d’identité est chez un parent dans une autre province.

Ils ne se passent pas de paiements. Ils retournent aux espèces.

## L’autre mur

L’approche inverse — ne rien demander — n’est pas une option non plus, et pas seulement parce qu’un régulateur finira par l’arrêter. Une plateforme qui n’a aucune idée de qui sont ses clients est une plateforme utilisée pour des choses que ses fondateurs ne choisiraient pas.

## Une échelle à la place

Le **palier 0** est un numéro de téléphone. Vous pouvez recevoir, dans des plafonds suffisamment petits pour être proportionnés au fait que l’on ne sait presque rien de vous.

Le **palier 1** ajoute une pièce d’identité et les plafonds montent.

Le **palier 2** ajoute l’adresse et l’origine des fonds, et les plafonds montent encore.

Personne n’est refoulé à la porte. Ce que quelqu’un peut faire est proportionné à ce que l’on sait de lui, et il peut changer cela en quelques minutes quand il le décide.

## Les plafonds refusent, visiblement

Une transaction au-delà du plafond d’un palier est **refusée**, avec un motif lisible qui nomme le palier — pas retenue en silence dans une file pendant que le client s’interroge.

S’entendre dire *« ceci dépasse le plafond de votre palier ; ajoutez un document pour le relever »* est une phrase utile. Ne rien s’entendre dire, c’est ainsi que les gens concluent que l’application est cassée.

Les plafonds sont de la configuration, pas du code. Quand une règle change, les plafonds changent, sans attendre une mise en production.

## Le filtrage est quotidien, pas unique

Le filtrage des sanctions tourne à l’entrée en relation **puis chaque jour** contre les listes consolidées officielles.

Cela compte plus qu’il n’y paraît. Un client irréprochable à son arrivée et qui apparaît sur une liste dix-huit mois plus tard est trouvé par le réexamen quotidien. Une plateforme qui ne filtre qu’à l’inscription l’apprend quand quelqu’un d’autre le lui dit.

## Les entreprises

La vérification d’entreprise contrôle le registre, les bénéficiaires effectifs au-delà du seuil déclaré et les dirigeants, et attribue un palier de risque qui est revu plutôt que fixé une fois puis oublié.

Chaque décision est enregistrée avec son auteur : le dossier peut être lu plus tard par quelqu’un qui n’était pas là — ce qui est le vrai test d’un dossier de conformité.

## Ce que cela coûte

Rien. Les paliers supérieurs débloquent des plafonds plus élevés, pas de meilleurs tarifs.`,
  },

  'risk-and-compliance': {
    name: 'Risque et conformité',
    tagline: 'Refusé avant, pas rappelé après.',
    headline: 'La différence entre bloquer un paiement et le regretter',
    excerpt:
      'Filtrer après que l’argent a bougé est une excuse. Filtrer à l’intérieur de l’écriture est un contrôle. Voici où se situe le contrôle, pourquoi cet emplacement est tout l’enjeu, et ce qu’il advient d’une alerte ensuite.',
    usp: 'Un filtrage des sanctions qui tourne à l’intérieur de l’écriture, avant que l’argent ne bouge, pour qu’un paiement bloqué soit refusé plutôt que rappelé — et chaque alerte devient un dossier avec une décision et un nom en face.',
    audience: 'Responsables conformité, équipes risque, partenaires menant une diligence raisonnable et régulateurs.',
    problem:
      'Beaucoup de plateformes filtrent de façon asynchrone : le paiement part, une tâche tourne, et une correspondance devient une demande de rappel et une lettre difficile. À ce moment-là, l’argent a généralement déjà rebougé.',
    how: [
      'Un point d’ancrage pré-validation filtre les deux parties à l’intérieur de l’écriture, avant qu’aucune ligne ne soit écrite.',
      'Une correspondance refuse la transaction et ouvre un dossier au lieu de la laisser se régler.',
      'Les règles de surveillance observent la vélocité, le fractionnement sous les plafonds, les rafales vers de nouveaux destinataires et les corridors à risque élevé.',
      'Chaque alerte devient un dossier avec une décision, un examinateur et la trace du pourquoi.',
    ],
    proof: [
      'Le filtrage est un point d’ancrage pré-validation sur l’écriture du grand livre : le contrôle a lieu avant que les lignes ne soient écrites, pas après leur règlement.',
      'Les sources officielles consolidées de sanctions sont enregistrées au premier démarrage et rafraîchies chaque jour.',
      'La surveillance produit des dossiers, pas seulement des signalements ; un dossier porte la décision, l’examinateur et le raisonnement.',
      'Un bénéficiaire ajouté pour la première fois peut exiger une vérification renforcée et un délai de carence avant qu’un montant important ne lui parvienne.',
      'Les changements de destination de règlement sont une action protégée, distincte des modifications ordinaires de profil.',
    ],
    cost: 'Non facturé séparément. C’est une condition d’exploitation, pas une option à vendre.',
    faq: [
      {
        question: 'Pourquoi mon paiement a-t-il été refusé ?',
        answer:
          'Un refus portant un code de conformité signifie que la transaction n’a pas passé un contrôle. Le support ne peut pas toujours expliquer lequel — c’est une contrainte légale, pas de l’évasion — mais un dossier existe et il est examiné par une personne.',
      },
      {
        question: 'Le filtrage ralentit-il chaque paiement ?',
        answer:
          'Le contrôle tourne à l’intérieur de l’écriture : il coûte le temps d’une recherche et non celui d’un traitement par lots. Les clients ne le vivent pas comme un délai ; ils ne le vivent que lorsque quelque chose est refusé.',
      },
      {
        question: 'Qu’est-ce qui empêche un client légitime d’être bloqué pour toujours ?',
        answer:
          'Chaque alerte devient un dossier avec un examinateur et une décision, pas un signalement silencieux permanent. Les dossiers sont traités par des personnes, et la décision est enregistrée avec son raisonnement : elle peut être réexaminée au lieu d’être devinée.',
      },
    ],
    articleSlug: 'risque-et-conformite-explique',
    article: `Il y a deux endroits où placer un contrôle de sanctions, et l’écart entre les deux est la différence entre un contrôle et une excuse.

## Après que l’argent a bougé

Le schéma courant : le paiement se règle, une tâche tourne quelques minutes ou quelques heures plus tard, et une correspondance produit une alerte.

Il faut maintenant rappeler de l’argent déjà arrivé — et très souvent déjà reparti. La plateforme écrit une lettre difficile. Le responsable conformité explique à un régulateur pourquoi un paiement interdit est allé au bout. Tout le monde s’accorde à revoir le processus.

Le contrôle a bien tourné. Il a juste tourné trop tard pour être un contrôle.

## À l’intérieur de l’écriture

Ici, le filtrage est un **point d’ancrage pré-validation sur l’écriture du grand livre**. Il tourne avant qu’aucune ligne ne soit écrite.

Une correspondance signifie que la transaction est **refusée**. Pas réglée puis signalée. Pas mise en file pour un rappel. Refusée — aucune ligne, aucun argent déplacé, rien à rappeler.

Cet emplacement est toute la fonctionnalité. Le reste est du détail.

## Des listes réellement à jour

Les sources officielles consolidées sont enregistrées au premier démarrage de la plateforme et rafraîchies chaque jour.

Une liste vieille de dix-huit mois est pire que pas de liste, parce qu’elle produit de la confiance sans protection.

## La surveillance porte sur des schémas

Le filtrage attrape des parties nommées. La surveillance attrape des comportements : vélocité, fractionnement juste sous un plafond, rafales de paiements vers des destinataires jamais vus, activité sur des corridors à risque élevé.

Ces règles ne refusent pas les paiements. Elles lèvent des alertes — et surtout, une alerte devient un **dossier**.

## Un dossier porte un nom

C’est ce qui sépare une fonction de conformité d’un tas de signalements.

Chaque alerte devient un dossier portant la décision, l’examinateur et le raisonnement. Quelqu’un a regardé ceci. Il a décidé cela. Voici pourquoi.

Des mois plus tard, quand un régulateur ou un partenaire demande des comptes sur un client précis, la réponse est un dossier et non un chantier de fouilles. Et comme la décision a été enregistrée avec son raisonnement, elle peut être **réexaminée** quand les circonstances changent, au lieu de laisser un client sous un signalement silencieux que personne ne se rappelle avoir posé.

## Deux contrôles plus discrets

Un **nouveau bénéficiaire** peut exiger une vérification renforcée et un délai de carence avant qu’un montant important ne lui parvienne. La plupart des pertes par usurpation de compte partent vers une adresse ajoutée quelques minutes plus tôt ; un court délai à la première utilisation en retire l’essentiel de la valeur.

Les **changements de destination de règlement** sont protégés, distincts des modifications ordinaires de profil — parce que rediriger les revenus d’une entreprise est la chose la plus précieuse qu’un attaquant puisse faire dans un compte.

## Ce que cela coûte

Rien. C’est une condition d’exploitation, pas une option à vendre.`,
  },

  disputes: {
    name: 'Remboursements et litiges',
    tagline: 'Une promesse que vous pouvez réellement tenir.',
    headline: 'Un remboursement que vous ne pouvez pas financer est pire qu’un refus',
    excerpt:
      'Promettre un remboursement puis découvrir que le solde n’est pas là transforme un client déçu en client en colère. Réserver d’abord, et traiter les litiges comme des objets avec des échéances, corrige les deux moitiés.',
    usp: 'Un remboursement qui réserve l’argent de façon atomique avant d’être promis, et un litige qui est un objet avec un calendrier plutôt qu’un fil d’e-mails que quelqu’un est censé se rappeler.',
    audience: 'Commerçants qui gèrent des retours, équipes de support, et clients facturés pour quelque chose qu’ils n’ont pas reçu.',
    problem:
      'Les remboursements sont d’habitude promis puis tentés. Si le solde du commerçant a déjà été réglé vers sa banque, le remboursement échoue après que le client a été prévenu de son arrivée — et les litiges vivent dans des boîtes de réception où les échéances se manquent.',
    how: [
      'Un remboursement réserve le montant de façon atomique avant d’être accepté — l’argent est sécurisé, puis la promesse est faite.',
      'Remboursez jusqu’à ce qui reste remboursable sur le paiement d’origine ; le montant restant est affiché.',
      'Un litige est un objet avec un état, une échéance et les preuves attachées.',
      'Les paiements répartis sont reprélevés au prorata, ou absorbés par le commerçant, selon la politique définie.',
    ],
    proof: [
      'Un remboursement réserve le montant de façon atomique ; un remboursement qui ne peut pas être financé est refusé au moment de la demande plutôt qu’échouer plus tard.',
      'Le solde remboursable d’un paiement est un montant que l’API rapporte : des remboursements partiels ne peuvent pas discrètement dépasser l’original.',
      'Les litiges sont des objets avec des états et des échéances, pas des fils d’e-mails : une échéance manquée est visible avant de l’être.',
      'Lorsqu’un paiement a été réparti entre plusieurs bénéficiaires, les remboursements sont répartis au prorata ou absorbés par le commerçant selon la politique enregistrée, et les reprises échouées peuvent être relancées.',
      'Un caissier ne peut rembourser que jusqu’au plafond fixé par l’entreprise ; au-delà, le remboursement est refusé.',
    ],
    cost: 'Rembourser rend l’argent au payeur. Lorsque des frais de prestataire sur le paiement d’origine ne sont pas restitués par le prestataire, le relevé l’affiche au lieu de l’absorber en silence.',
    faq: [
      {
        question: 'Puis-je rembourser plusieurs fois sur le même paiement ?',
        answer: 'Oui, jusqu’à ce qui reste remboursable. Le montant remboursable restant est rapporté : une série de remboursements partiels ne peut pas discrètement dépasser le paiement d’origine.',
      },
      {
        question: 'Que devient un remboursement sur un paiement qui a été réparti ?',
        answer:
          'Il suit la politique enregistrée sur le paiement : chaque bénéficiaire rend sa part au prorata, ou le commerçant absorbe la totalité. Une reprise qui échoue peut être relancée au lieu d’être abandonnée en silence.',
      },
      {
        question: 'Pourquoi mon remboursement a-t-il été refusé ?',
        answer:
          'Le plus souvent parce que le montant n’a pas pu être réservé — les fonds n’étaient pas disponibles au moment de la demande. Être refusé à ce moment-là est délibérément préférable à voir un remboursement promis échouer ensuite.',
      },
    ],
    articleSlug: 'remboursements-et-litiges-explique',
    article: `Il y a une chose pire que de dire à un client que vous ne pouvez pas le rembourser : lui dire que vous pouvez, puis échouer.

La première est une déception. La seconde est une réclamation, un avis en ligne et le plus souvent une contestation bancaire.

## Pourquoi les remboursements échouent tard

L’ordre habituel est : accepter le remboursement, prévenir le client, puis le tenter.

Au moment où il est tenté, le solde du commerçant peut déjà avoir été réglé vers sa banque. Le remboursement échoue. Le client a déjà été prévenu. Personne n’a rien fait de mal, et vous voilà quand même là.

## Réserver d’abord, promettre ensuite

Ici, un remboursement **réserve le montant de façon atomique** avant d’être accepté.

Si l’argent ne peut pas être réservé, le remboursement est refusé **au moment de la demande** — pendant que vous parlez encore au client, quand vous pouvez dire *« je dois organiser cela, donnez-moi une heure »* au lieu de *« c’est envoyé »* suivi d’un silence.

Être refusé tôt est moins bien qu’être accepté et fonctionner. C’est bien mieux qu’être accepté puis échouer.

## Des remboursements partiels qui ne peuvent pas déborder

Chaque paiement rapporte ce qui reste remboursable sur lui.

Remboursez la moitié aujourd’hui, un quart la semaine prochaine, et le montant restant est un chiffre que le système connaît — pas une chose que votre support suit dans un tableur et se trompe parfois à l’avantage du client.

## Les répartitions

Lorsqu’un paiement a été réparti entre plusieurs bénéficiaires — une place de marché, une plateforme qui prend une commission, une coopérative qui partage ses recettes — un remboursement doit bien venir de quelque part.

La politique est enregistrée sur le paiement : chaque bénéficiaire rend sa part **au prorata**, ou le commerçant **absorbe** la totalité. Les deux sont légitimes ; ce qui compte, c’est que ce soit décidé à l’avance plutôt que disputé après.

Une reprise qui échoue — un bénéficiaire dont le solde est insuffisant — peut être relancée, au lieu d’être abandonnée en silence puis découverte lors d’un rapprochement de fin d’année.

## Les litiges sont des objets, pas des boîtes de réception

Dans la plupart des entreprises, un litige vit dans une boîte de réception. Les boîtes de réception n’ont pas d’échéances ; les gens en ont, et les gens oublient.

Ici, un litige est un **objet** : un état, un calendrier, les preuves attachées. Une échéance qui approche est visible **avant** d’être manquée, seul moment où cette information est utile.

## Le plafond du caissier s’applique aussi

Un caissier peut rembourser jusqu’au plafond fixé par l’entreprise. Au-delà, le remboursement est refusé et doit être fait par quelqu’un qui en a l’autorité.

Les remboursements sont l’endroit où un comptoir fuit, et le plafond est ce qui empêche une fuite lente de devenir une inondation.

## Ce que cela coûte

Un remboursement rend l’argent au payeur. Lorsque les frais d’un prestataire sur le paiement d’origine ne sont pas restitués par ce prestataire, le relevé l’affiche au lieu de l’absorber discrètement — vous connaissez ainsi le coût réel d’un retour.`,
  },

  'corridor-network': {
    name: 'Réseau de corridors',
    tagline: 'La posture réglementaire comme configuration.',
    headline: 'Construire un réseau de paiement en quatre phases, sans le réécrire à chaque fois',
    excerpt:
      'La plupart des entreprises de paiement se reconstruisent à chaque étape réglementaire. Si la posture d’un corridor est une donnée plutôt que des branches dans le code, passer de l’orchestration à l’émission change des lignes et rien d’autre.',
    usp: 'Un corridor inscrit la phase dans laquelle il se trouve, sous quelle licence et avec quel modèle de détention des fonds — comme donnée, pour que passer d’orchestrateur à émetteur agréé change des lignes plutôt que du code.',
    audience: 'Conseils d’administration, régulateurs, banques partenaires, investisseurs et les ingénieurs à qui l’on demanderait sinon de reconstruire la plateforme tous les dix-huit mois.',
    problem:
      'Une activité de paiement change de forme à mesure qu’elle obtient des licences. Si la détention des fonds, la base réglementaire et les rails autorisés sont des hypothèses figées dans le code, chaque étape est une réécriture, et chaque réécriture est une occasion de se tromper sur un comportement réglementé.',
    how: [
      'Chaque corridor inscrit sa phase, son régime réglementaire, la licence sous laquelle il opère et qui détient les fonds.',
      'Les rails qu’il peut utiliser, ses plafonds et les mécanismes de règlement qui y sont permis sont déclarés à côté.',
      'Un corridor ne peut pas passer en production tant que sa posture est incomplète, et le refus nomme ce qui manque.',
      'Les mécanismes de règlement qui exigent une décision restent désactivés jusqu’à ce que cette décision soit enregistrée, avec son motif conservé.',
    ],
    proof: [
      'Phase, régime réglementaire, base réglementaire, modèle de détention, rails et plafonds sont des lignes, pas des branches dans le code.',
      'L’état actif est refusé à un corridor tant que sa posture est incomplète, et le refus énumère exactement ce qui manque.',
      'Les positions de contrepartie compensent ce qu’un partenaire a reçu avec ce qu’il a versé, et le préfinancement est délibérément exclu pour qu’aucun mouvement ne soit compté deux fois.',
      'Les lots de règlement sont proposés par un administrateur et approuvés par un autre, et le rail est revérifié au moment de l’instruction.',
      'Les jalons de phase ne sont atteints que face à une mesure et aux preuves derrière elle, et les questions ouvertes qui bloquent une phase sont enregistrées avec ce que chacune bloque.',
    ],
    cost: 'Ce n’est pas un produit destiné aux clients. C’est la machinerie sur laquelle tourne un corridor, et la discipline avec laquelle un conseil décide si la phase suivante est financée.',
    faq: [
      {
        question: 'Pourquoi une entreprise de paiement publierait-elle ses propres jalons de phase ?',
        answer:
          'Parce que l’alternative est de décider d’engager la tranche suivante sur une impression. Un jalon atteint face à une mesure, avec les preuves enregistrées, est une décision que l’on peut défendre — devant un conseil, un investisseur ou un régulateur.',
      },
      {
        question: 'Que veut dire concrètement « posture réglementaire comme donnée » ?',
        answer:
          'Que le caractère dépositaire d’un corridor, la licence sous laquelle il opère et les mécanismes de règlement qu’il peut utiliser sont des lignes dans un registre plutôt que des hypothèses compilées dans le logiciel. Changer de posture devient alors un acte administratif avec une piste d’audit, pas une mise en production.',
      },
      {
        question: 'Pourquoi le préfinancement est-il tenu hors de la position ?',
        answer:
          'Parce que placer la liquidité propre de BitriPay chez un partenaire est un mouvement de trésorerie, pas quelque chose que le partenaire doit. Le compter aux deux endroits rendrait chaque position fausse — il existe un test dont le seul rôle est de maintenir cela vrai.',
      },
    ],
    articleSlug: 'reseau-de-corridors-explique',
    article: `Les entreprises de paiement changent de forme à mesure qu’elles obtiennent des licences. Elles commencent par orchestrer les rails de quelqu’un d’autre, puis prennent un corridor de bout en bout, puis détiennent leur propre agrément.

Le coût habituel de chaque étape est une réécriture, et le risque habituel de chaque réécriture est qu’un comportement réglementé change discrètement en chemin.

## L’hypothèse qui devient une reconstruction

Au début, quelqu’un écrit du code qui suppose que la plateforme ne détient pas de fonds de clients. C’est vrai, donc ce n’est écrit nulle part — c’est simplement ce que fait le code.

Deux ans plus tard, l’entreprise est agréée pour détenir des fonds, et cette hypothèse est répartie sur des centaines de fichiers sous la forme de l’absence de quelque chose. C’est désormais une réécriture, menée sous pression commerciale, dans la partie du système où les erreurs pardonnent le moins.

## La posture comme lignes

Un corridor inscrit ici, comme donnée :

- la **phase** dans laquelle il se trouve,
- son **régime réglementaire** — non dépositaire, détention par le partenaire, agrément propre, opérateur de réseau,
- la **base réglementaire** sous laquelle il opère et qui détient les fonds,
- les **rails** qu’il peut utiliser et les **plafonds** qui s’appliquent,
- les **mécanismes de règlement** qui y sont permis.

Passer d’une phase à la suivante change des lignes. Le code n’a pas d’opinion sur la détention des fonds, parce que la détention est un champ.

## Une posture incomplète ne peut pas passer en production

L’état actif est refusé à un corridor tant que sa posture est incomplète, et le refus **nomme ce qui manque** : pas de base réglementaire, pas de rail de versement, pas de plafond journalier.

C’est un petit mécanisme aux grandes conséquences. La défaillance réglementaire la plus courante dans le paiement n’est pas la désobéissance ; c’est un corridor passé en production pendant que quelqu’un courait encore après un document, et que personne n’a rien remarqué parce que rien ne l’avait arrêté.

## Un règlement qui ne peut pas être compté deux fois

Les positions de contrepartie compensent ce qu’un partenaire a reçu pour vous avec ce qu’il a versé pour vous.

**Le préfinancement est délibérément exclu.** Placer votre propre liquidité chez un partenaire est un mouvement de trésorerie, pas une dette du partenaire envers vous. Le compter aux deux endroits rend chaque position fausse — discrètement, et en votre faveur, qui est la pire direction dans laquelle une erreur puisse pencher.

Il existe un test dont le seul rôle est de maintenir cela vrai.

## Des mécanismes qui restent désactivés

Un mécanisme de règlement qui exige une décision — une participation parrainée, un jeton de règlement — est **désactivé sur chaque corridor** jusqu’à ce que cette décision soit enregistrée, avec son motif conservé en face.

Pas désactivé par convention. Désactivé par refus.

## Des jalons avec des preuves

Un jalon de phase n’est atteint que face à une **mesure** et aux **preuves** derrière elle. Les deux sont exigées ; un jalon ne peut pas être marqué atteint parce que quelqu’un est confiant.

À côté se trouvent les questions ouvertes, chacune enregistrant ce qu’elle bloque. Un conseil qui décide de financer la phase suivante peut voir ce qui est réellement tranché et ce qui reste un espoir.

C’est un document inconfortable à tenir. C’est une conversation considérablement plus inconfortable à avoir sans lui.`,
  },

  'ussd-and-sms': {
    name: 'USSD et SMS',
    tagline: 'Pas de smartphone. Pas de données. Le même compte.',
    headline: 'Les clients que tous les autres excluent par conception',
    excerpt:
      'Tous les produits de paiement supposent un smartphone et un forfait de données. La plupart des gens qui ont le plus besoin d’argent numérique n’ont ni l’un ni l’autre. L’USSD et le SMS ne sont pas une version dégradée — c’est le même compte par une autre porte.',
    usp: 'Le même grand livre, les mêmes soldes et les mêmes plafonds atteints depuis un téléphone simple sans données — pas un produit réduit pour les clients plus pauvres, le même produit par une autre porte.',
    audience: 'Toute personne avec un téléphone simple, toute personne à court de données, toute personne là où le signal porte la voix et pas beaucoup plus.',
    problem:
      'Un produit qui exige une application et un forfait de données a discrètement décidé qui sont ses clients. Dans une grande partie de la région, cette décision exclut l’essentiel du marché, et l’exclut durablement plutôt que temporairement.',
    how: [
      'Composez le code court depuis n’importe quel téléphone, y compris un téléphone simple sans données.',
      'Avancez dans un menu numéroté : solde, envoyer, demander, payer un code.',
      'Confirmez avec le même code PIN qui protège le compte dans l’application.',
      'Une commande peut aussi être envoyée par SMS, pour les endroits où même une session est peu fiable.',
    ],
    proof: [
      'L’USSD et le SMS atteignent les mêmes comptes, le même grand livre et les mêmes plafonds que l’application — pas un système parallèle avec ses propres soldes.',
      'Le code PIN de transaction qui protège le compte dans l’application est le code PIN qui le protège en USSD.',
      'Une session qui tombe en cours de route ne laisse pas un paiement à moitié fait : l’écriture a eu lieu ou n’a pas eu lieu.',
      'Le canal de commandes est simulé dans la console : un changement peut être testé sans combiné.',
    ],
    cost: 'Les frais de session de l’opérateur s’appliquent comme pour tout USSD. BitriPay n’ajoute aucun frais pour l’usage de cette porte plutôt que de l’application.',
    faq: [
      {
        question: 'Est-ce une version allégée avec des plafonds plus bas ?',
        answer: 'Non. Même compte, même grand livre, mêmes plafonds, même code PIN. Le menu est plus petit parce que l’écran d’un téléphone simple est plus petit, pas parce que le client vaut moins.',
      },
      {
        question: 'Ma session est tombée au milieu. Ai-je payé deux fois ?',
        answer: 'Non. L’écriture a eu lieu ou n’a pas eu lieu ; il n’existe pas de paiement à moitié fait. Consultez votre solde et la dernière transaction, et vous verrez lequel des deux.',
      },
      {
        question: 'Pourquoi s’en soucier, puisque tout le monde finira par avoir un smartphone ?',
        answer:
          'Parce que « finira par » n’est pas une stratégie de paiement pour quelqu’un qui doit envoyer de l’argent à sa mère cet après-midi. Et un propriétaire de smartphone à court de données est, pour cet après-midi, exactement le même client.',
      },
    ],
    articleSlug: 'ussd-et-sms-explique',
    article: `Ouvrez le parcours d’inscription de presque n’importe quel produit de paiement et la première hypothèse est un smartphone. La seconde est un forfait de données. Aucune n’est énoncée, parce qu’aucune n’est remarquée.

Dans une grande partie de la région que BitriPay sert, ces deux hypothèses tacites excluent l’essentiel du marché.

## La décision que personne n’écrit

Un produit qui exige une application a décidé qui sont ses clients. Pas délibérément — personne n’a tenu de réunion à ce sujet — mais la décision est prise et elle est durable.

Les personnes exclues ne sont pas un cas marginal. C’est la commerçante avec un téléphone simple qui tient cinq jours sur une charge, la grand-mère qui reçoit de l’argent de son fils, le livreur dont les données se sont épuisées mardi et dont le prochain forfait est vendredi.

Ils ont de l’argent. Ils ont besoin de le déplacer. Ils ne sont pas servis.

## Même compte, autre porte

L’USSD est l’enjeu ici, et l’enjeu mérite d’être énoncé précisément : **ce n’est pas un produit réduit.**

Le même compte. Le même grand livre. Les mêmes plafonds. Le même code PIN de transaction qui protège le compte dans l’application.

Le menu est plus court parce que l’écran d’un téléphone simple est plus court. C’est toute la différence. Un client sur un téléphone simple ne vaut pas moins et n’obtient pas moins.

## Les sessions qui tombent

Les sessions USSD tombent. Le signal s’en va, l’opérateur expire, quelqu’un passe derrière un mur.

La question qui compte est ce qu’il advient d’un paiement à mi-parcours. La réponse est qu’il n’y a pas de mi-parcours : l’écriture a eu lieu ou n’a pas eu lieu. Consultez le solde et la dernière transaction et vous saurez lequel.

Ce n’est pas un traitement spécial pour l’USSD — c’est ce qu’une écriture équilibrée sur un grand livre unique vous donne gratuitement. Un paiement qui ne peut pas être écrit à moitié ne peut pas non plus l’être à travers une session tombée.

## Le SMS, pour quand même une session est trop

Certains endroits ont un signal qui porte un texte et pas beaucoup plus. Une commande peut être envoyée par SMS pour exactement ces endroits.

C’est le canal le moins élégant du produit et parfois le seul qui fonctionne.

## Et le propriétaire de smartphone sans données

Cela mérite d’être dit, parce qu’il est facile d’y voir une fonctionnalité pour les autres.

Un propriétaire de smartphone à court de données est, jusqu’à vendredi, exactement le même client que quelqu’un qui n’en a jamais possédé. La porte qui existe pour l’un sert les deux.

## Ce que cela coûte

L’opérateur facture la session, comme pour tout USSD. BitriPay n’ajoute rien pour l’usage de cette porte plutôt que de l’application.`,
  },

  'bitripay-lite': {
    name: 'BitriPay Lite',
    tagline: 'Fonctionne avec la connexion que vous avez vraiment.',
    headline: 'Une application de paiement qui fonctionne quand la connexion ne fonctionne pas',
    excerpt:
      'Une application web moderne suppose des mégaoctets de JavaScript et une connexion qui les livre. Lite est le même compte rendu sur le serveur, sans aucun JavaScript, pour les jours où le réseau passe un de ces après-midi.',
    usp: 'Une application web complète qui fonctionne avec le JavaScript entièrement désactivé, rendue sur le serveur, pour qu’elle se charge sur une connexion lente et un navigateur ancien au lieu d’afficher un indicateur de chargement.',
    audience: 'Toute personne sur une connexion lente ou chère, un téléphone ancien, un navigateur bas de gamme, ou un réseau qui passe une mauvaise journée.',
    problem: 'Une application monopage qui ne se télécharge pas est un écran blanc. Sur un réseau saturé, ce n’est pas rare, et le client conclut que le service est cassé plutôt que la connexion.',
    how: [
      'Ouvrez l’adresse Lite au lieu de l’application.',
      'Les pages sont rendues sur le serveur et livrées en HTML simple.',
      'Tout fonctionne par des liens ordinaires et des envois de formulaires.',
      'Rien ne dépend du JavaScript : rien ne casse quand il n’arrive pas.',
    ],
    proof: [
      'Lite est rendu sur le serveur et n’exige aucun JavaScript — pas un repli dégradé, une surface qui fonctionne.',
      'Il atteint les mêmes comptes et le même grand livre que l’application complète.',
      'Les pages sont assez petites pour arriver sur une connexion saturée là où un paquet monopage n’arriverait pas.',
      'Il fonctionne dans des navigateurs trop anciens pour un cadriciel applicatif moderne.',
    ],
    cost: 'Gratuit, et il consomme nettement moins de données que l’application complète — ce qui, sur une connexion facturée au volume, est tout l’intérêt.',
    faq: [
      {
        question: 'Est-ce moins sûr parce que c’est plus simple ?',
        answer:
          'Non. La même connexion, le même code PIN, les mêmes plafonds et les mêmes contrôles côté serveur s’appliquent. Rien de la sécurité ne vit dans le JavaScript de l’application complète — si c’était le cas, ce serait le problème, pas Lite.',
      },
      {
        question: 'Puis-je tout y faire ?',
        answer: 'Les choses qui comptent sur une mauvaise connexion : le solde, recevoir, payer, demander, et votre relevé. C’est conçu pour l’après-midi où le réseau va mal.',
      },
      {
        question: 'Pourquoi ne pas simplement rendre l’application principale plus rapide ?',
        answer:
          'Nous le faisons aussi. Mais il existe un niveau de connexion en dessous duquel aucune optimisation ne livre un mégaoctet de JavaScript, et il y a chaque jour plus de zéro clients à ce niveau.',
      },
    ],
    articleSlug: 'bitripay-lite-explique',
    article: `Il existe une défaillance particulière qui apprend aux clients qu’un service est cassé, et ce n’est pas un message d’erreur. C’est un écran blanc.

Le JavaScript de l’application n’a pas fini de se télécharger. Rien ne s’est affiché. Il n’y a rien à lire, rien à toucher et rien pour expliquer ce qui s’est passé.

## Pourquoi cela arrive si souvent ici

Une application web moderne est de quelques mégaoctets de JavaScript qui doivent arriver avant que quoi que ce soit n’apparaisse à l’écran.

Sur une bonne connexion, c’est invisible. Sur une cellule saturée à dix-sept heures, sur un forfait presque épuisé, sur un téléphone vieux de trois générations, c’est un écran blanc pendant vingt secondes suivi d’un client qui a renoncé.

L’optimisation aide. Elle n’aide pas en dessous d’un certain plancher, et un nombre significatif de gens sont sous ce plancher chaque jour.

## Rendu là où est l’ordinateur

Lite est le même compte, rendu sur le serveur et livré en HTML simple.

Pas de JavaScript. Pas *se dégrade élégamment sans JavaScript* — **aucun du tout**. Des liens ordinaires. Des formulaires ordinaires. Le web tel qu’il fonctionnait avant d’avoir besoin d’une étape de compilation.

Une page arrive en kilo-octets et s’affiche à l’instant où elle atterrit. Il n’y a aucun paquet à attendre, parce qu’il n’y a aucun paquet.

## Pas un produit inférieur

Il atteint les mêmes comptes, le même grand livre, les mêmes soldes. La même connexion, le même code PIN, les mêmes plafonds, les mêmes contrôles côté serveur.

Rien de la sécurité de l’application complète ne vit dans son JavaScript. Si c’était le cas, ce serait un défaut de l’application complète plutôt qu’une raison de se méfier de Lite.

## Les navigateurs anciens

Les téléphones bas de gamme sont livrés avec des navigateurs déjà en retard de plusieurs années, et ils ne sont pas mis à jour. Un cadriciel qui exige un navigateur récent a exclu ces clients aussi sûrement qu’en leur demandant un passeport.

Le HTML rendu sur le serveur fonctionne dans tous, parce que c’est la chose que les navigateurs ont toujours faite.

## L’argument des données

Sur un forfait facturé au volume, la différence entre des kilo-octets et des mégaoctets n’est pas une élégance d’ingénieur. C’est de savoir si consulter votre solde vous coûte quelque chose que vous gardiez pour autre chose.

## Quand l’utiliser

Gardez l’application complète pour les jours ordinaires. Ouvrez Lite quand le réseau passe un de ces après-midi, quand le forfait est presque fini, ou quand vous utilisez un téléphone qui n’est pas le vôtre.

C’est celle qui fonctionne quand l’autre ne fonctionne pas.`,
  },

  'offline-payments': {
    name: 'Paiements hors réseau',
    tagline: 'Commercer quand le réseau a disparu.',
    headline: 'Payer quand il n’y a aucun réseau',
    excerpt:
      'Les réseaux tombent exactement aux mauvais moments. Une promesse signée et comptée échangée entre deux téléphones permet à une vente de se conclure maintenant et de se régler au retour du signal — sans créer un moyen de dépenser deux fois le même argent.',
    usp: 'Une promesse signée échangée entre deux téléphones sans aucun réseau, avec des compteurs et des nonces pour que la même promesse ne puisse pas être dépensée deux fois au retour du signal.',
    audience: 'Commerçants dans des lieux sans signal fiable, marchés qui perdent la couverture aux heures de pointe, quiconque voit son activité s’arrêter quand le réseau s’arrête.',
    problem:
      'Quand le réseau s’en va, le paiement numérique s’arrête et tout le monde revient aux espèces. La solution évidente — laisser les téléphones s’accorder et se synchroniser plus tard — est aussi le moyen évident de laisser quelqu’un dépenser le même solde dans quatre endroits.',
    how: [
      'Le téléphone du payeur produit une promesse signée portant le montant, un nonce et un compteur.',
      'Le téléphone du commerçant vérifie la signature et l’enregistre, sans aucun réseau.',
      'Les deux côtés voient le paiement comme en attente de confirmation — et l’écran le dit au lieu d’affirmer que c’est fait.',
      'Dès qu’un des téléphones trouve un signal, les promesses sont synchronisées et réglées, et les trous dans le compteur sont visibles.',
    ],
    proof: [
      'Une promesse est signée par la clé d’appareil enrôlée du payeur : elle ne peut pas être fabriquée par le téléphone du commerçant.',
      'Chaque promesse porte un nonce et un compteur par appareil ; une promesse rejouée est reconnue et une valeur de compteur manquante apparaît comme un trou.',
      'L’état en attente est montré aux deux côtés en mots clairs au lieu d’être présenté comme un paiement abouti.',
      'Les promesses ont une échéance : une promesse non synchronisée ne reste pas indéfiniment une créance ouverte.',
      'Les trous de compteur sont listés par appareil : un appareil qui a cessé de se synchroniser est visible au lieu d’être présumé sain.',
    ],
    cost: 'Aucun frais supplémentaire. Le paiement est tarifé comme un paiement ordinaire lorsqu’il se règle.',
    faq: [
      {
        question: 'Qu’est-ce qui empêche quelqu’un de dépenser deux fois le même argent hors réseau ?',
        answer:
          'Chaque promesse porte un nonce et un compteur par appareil. Les rejeux sont reconnus, et un trou dans le compteur est visible à la synchronisation de l’appareil. Il n’est pas possible de rendre la dépense hors réseau sans risque — c’est pourquoi l’exposition est bornée par des plafonds et une échéance, et pourquoi les deux côtés sont informés que le paiement est en attente et non abouti.',
      },
      {
        question: 'Le commerçant doit-il faire confiance au client ?',
        answer:
          'Moins qu’avec des espèces, et considérablement moins qu’avec une capture d’écran. La promesse est signée par l’appareil enrôlé du payeur et ne peut pas être fabriquée par le téléphone du commerçant — mais c’est une promesse jusqu’à son règlement, et l’écran le dit exactement.',
      },
      {
        question: 'Et si un téléphone ne revient jamais en ligne ?',
        answer: 'Les promesses expirent, et les trous de compteur par appareil sont listés : un appareil qui a cessé de se synchroniser est visible au lieu d’être discrètement présumé en bon état.',
      },
    ],
    articleSlug: 'paiements-hors-reseau-explique',
    article: `Les réseaux tombent aux pires moments possibles : jour de marché, l’heure avant la fermeture, l’après-midi où tout le monde est payé.

Quand le signal s’en va, le paiement numérique s’arrête et tout le monde revient aux espèces — précisément au moment où un commerçant en porte le plus.

## La solution évidente et son trou évident

Laisser les deux téléphones s’accorder entre eux et se synchroniser plus tard.

Cela marche à merveille jusqu’à ce que quelqu’un comprenne qu’il peut faire la même promesse hors réseau à quatre commerçants différents dans quatre coins du marché, et disparaître avant qu’aucun des téléphones ne trouve un signal.

Le paiement hors réseau est facile. Le paiement hors réseau qui n’est pas une machine à double dépense est le vrai problème.

## Une promesse signée et comptée

Le téléphone du payeur produit une promesse portant le montant, un **nonce** et un **compteur par appareil**, signée par la clé enrôlée de l’appareil.

Le téléphone du commerçant vérifie cette signature sans aucun réseau. Il ne peut pas fabriquer de promesse, parce qu’il ne détient pas la clé du payeur.

Le nonce fait qu’une promesse rejouée est reconnue. Le compteur fait qu’un **trou** est visible : si un appareil synchronise les promesses 41, 42 et 44, quelqu’un détient la 43 et le système sait qu’il faut la chercher.

## La part honnête

On ne peut pas rendre la dépense hors réseau sans risque. Quiconque prétend le contraire vend quelque chose.

Ce que l’on peut faire, c’est borner l’exposition et dire la vérité à son sujet :

- Les **plafonds** limitent ce qui peut être promis hors réseau avant synchronisation.
- L’**échéance** fait qu’une promesse non synchronisée ne reste pas éternellement une créance ouverte.
- Les **trous de compteur** sont listés par appareil : un téléphone qui a cessé de se synchroniser est visible au lieu d’être présumé sain.
- Et les deux côtés voient les mots **en attente de confirmation** plutôt qu’une coche verte.

Ce dernier point compte le plus. Un commerçant qui sait qu’un paiement est une promesse peut décider de remettre ou non la marchandise selon le montant et le client. Un commerçant à qui l’on montre une coche qui ne veut rien dire s’est fait mentir.

## Ce qui reste préférable aux espèces

Les espèces un jour de marché, c’est porter des billets dans une foule et les garder la nuit. Une promesse signée par un appareil enrôlé, en attente de confirmation, bornée par un plafond, est un risque plus petit qu’une caisse pleine — et considérablement plus petit qu’une capture d’écran sur le téléphone d’un inconnu.

## Au retour du signal

Les promesses se synchronisent et se règlent. Les deux côtés voient le paiement passer d’en attente à réglé, et le commerçant voit l’argent.

La vente a eu lieu quand le client était là. Le règlement a eu lieu quand le réseau l’a permis. Ce sont deux événements différents, et le produit ne prétend pas qu’ils n’en font qu’un.`,
  },

  notifications: {
    name: 'Des alertes impossibles à manquer',
    tagline: 'S’il n’y a pas eu de son, il n’y a pas eu d’argent.',
    headline: 'Pourquoi le son compte plus que l’écran',
    excerpt:
      'Une commerçante avec une file ne lit pas une notification. Elle en entend une, ou pas. Rendre l’alerte forte, longue et sans équivoque n’est pas de la finition — c’est le contrôle qui arrête la fraude à la capture d’écran.',
    usp: 'Une alarme forte et une vibration longue conçues pour être entendues à travers un marché et comprises sans lire, parce que le son est le reçu sur lequel une commerçante compte réellement.',
    audience: 'Commerçantes de marché, livreurs, boutiquiers, agents — toute personne qui encaisse les mains pleines et les yeux ailleurs.',
    problem:
      'La fraude standard sur un étal est la capture d’écran. Le client montre une image convaincante d’un paiement qui n’a jamais eu lieu et repart avec la marchandise. Une notification discrète n’est aucune défense ; elle n’a jamais été vue.',
    how: [
      'L’arrivée d’un paiement déclenche une alarme forte et vibre plusieurs secondes, pas un petit carillon.',
      'L’écran affiche le montant en gros chiffres, une coche verte et le nom du payeur.',
      'L’alerte peut être testée depuis les réglages : le son est familier avant de compter.',
      'La même alerte atteint l’application mobile, l’application web et l’appareil de versement.',
    ],
    proof: [
      'L’alerte est conçue pour être audible dans un marché bruyant et comprise sans lire l’écran.',
      'Elle se déclenche à l’arrivée de l’argent, pas au démarrage d’un paiement : elle ne peut pas être provoquée par la seule action d’un client.',
      'Elle peut être testée depuis les réglages : une commerçante apprend le son avant le premier vrai paiement.',
      'Le même événement atteint toutes les surfaces : un commerçant qui regarde un écran de caisse et une commerçante qui tient un téléphone entendent la même chose.',
    ],
    cost: 'Inclus sur chaque compte et chaque surface. Il n’existe pas de formule supérieure qui rende l’alerte plus forte, parce qu’une alerte qu’une commerçante n’entend pas ne vaut pas la peine d’être vendue.',
    faq: [
      {
        question: 'Un client peut-il imiter le son ?',
        answer:
          'Il peut jouer un enregistrement, et c’est pourquoi le son vient de votre téléphone et non du sien. N’acceptez jamais un son, un écran ou une capture venant de l’appareil du payeur — l’alerte qui compte est celle que votre propre téléphone produit.',
      },
      {
        question: 'C’est trop fort / pas assez fort.',
        answer:
          'Testez-la depuis les réglages et réglez le volume du téléphone pour l’entendre d’un bout à l’autre de votre étal. La familiarité est l’objectif : vous devez la reconnaître sans regarder.',
      },
      {
        question: 'Et si je ne l’ai réellement pas entendue ?',
        answer:
          'Consultez la liste des transactions avant de remettre la marchandise. La règle porte sur ce sur quoi vous pouvez compter dans la précipitation, ce n’est pas une raison de ne pas vérifier quand vous doutez.',
      },
    ],
    articleSlug: 'des-alertes-impossibles-a-manquer-explique',
    article: `Une commerçante avec six personnes dans la file ne lit pas les notifications. Ses mains sont pleines, ses yeux sont sur la marchandise et l’argent, et le téléphone est quelque part sur la table.

Elle entend un son, ou pas.

## La fraude que cela existe pour arrêter

C’est la plus simple du marché, et elle fonctionne en permanence.

Le client tapote son téléphone un instant, retourne l’écran, et montre une image convaincante d’un paiement abouti. La commerçante est occupée. L’image a l’air juste. La marchandise traverse la table.

L’image était la capture du paiement de quelqu’un d’autre, ou une image modifiée, ou un paiement vers un tout autre numéro.

Une notification discrète n’est absolument aucune défense contre cela, parce que la notification discrète n’a jamais été vue.

## Forte, longue, et venant de votre propre téléphone

L’alerte est une véritable alarme et une vibration de plusieurs secondes. L’écran affiche le montant en gros chiffres, une coche verte et le nom du payeur.

Elle est conçue pour être entendue à travers un marché bruyant et comprise sans lire, parce qu’un nombre significatif de ceux qui en dépendent ne lisent pas facilement, et qu’aucun d’eux ne regarde l’écran au moment où cela compte.

## Une règle, pour tout le monde

> S’il n’y a pas eu de son, il n’y a pas eu d’argent.

C’est tout, et cela tient sur une pancarte au-dessus d’un étal.

Pas une capture d’écran. Pas l’écran du client. Pas *c’est passé, je vous assure*. Pas un message d’un numéro que vous ne connaissez pas. C’est **votre** téléphone qui produit le son, ou aucun argent n’est arrivé.

## Pourquoi votre téléphone et pas le sien

Tout ce que l’appareil du payeur vous montre est une chose que le payeur contrôle — une capture, un enregistrement, une image modifiée, une application sosie.

L’alerte qui compte est celle que votre propre téléphone produit, parce que celle-là vient de l’arrivée réelle du paiement.

## Testez-la avant d’en avoir besoin

Il y a une alerte de test dans les réglages. Utilisez-la. Réglez votre volume pour l’entendre depuis le bout de votre étal.

L’objectif est la familiarité : vous devez connaître ce son sans lever les yeux, comme vous connaissez le son de votre propre nom.

## Partout à la fois

Le même événement atteint l’application mobile, l’application web et l’appareil de versement : un boutiquier qui surveille une caisse et une commerçante qui tient un téléphone entendent la même chose au sujet du même argent.

## Ce que cela coûte

Rien. C’est le reçu.`,
  },

  'smart-route': {
    name: 'Smart Route',
    tagline: 'Le rail qui marchera, pas le rail qui vient en premier.',
    headline: 'Comment un paiement décide par où passer',
    excerpt:
      'Un paiement peut généralement voyager par plusieurs chemins, et ils ne sont pas tous aussi bons à deux heures du matin. Router sur le succès mesuré, le coût et la latence — avec un disjoncteur sur les rails défaillants — fait la différence entre la résilience et une mauvaise nuit.',
    usp: 'Un routage noté à partir des taux de succès mesurés, du coût et de la latence par connecteur, avec un disjoncteur qui retire un rail défaillant avant que vos clients ne le trouvent.',
    audience: 'Commerçants qui perdent des ventes à cause de paiements échoués, et développeurs qui construiraient sinon leur propre bascule.',
    problem:
      'La plupart des intégrations figent un seul prestataire. Quand il se dégrade, chaque paiement se dégrade avec lui, et l’entreprise l’apprend par ses clients plutôt que par un tableau de bord.',
    how: [
      'Les connecteurs candidats sont rassemblés parmi ceux qui peuvent réellement porter ce paiement.',
      'Chacun est noté sur son taux de succès mesuré, son coût total et sa latence observée.',
      'Le disjoncteur retire un connecteur qui échoue, et le réadmet progressivement une fois rétabli.',
      'Une politique de commerçant peut orienter le choix vers le moins cher, le plus rapide ou le plus fiable.',
    ],
    proof: [
      'Les notes viennent d’une télémétrie conservée par tranches de quinze minutes sur vingt-quatre heures, éventuellement indexée par tranche de montant et par préfixe, plutôt que d’une liste de préférences figée.',
      'Le disjoncteur passe de fermé à ouvert après des fautes consécutives, puis à demi-ouvert après un délai, puis à fermé au succès suivant : un rail qui se rétablit est testé avec un paiement et non avec tous.',
      'La santé est un état par connecteur — sain, dégradé, indisponible, en maintenance — déduit du disjoncteur, de la dernière sonde et des succès récents.',
      'La bascule n’a lieu que pour les erreurs qui garantissent qu’aucun argent n’a bougé ; tout ce qui est ambigu déclenche d’abord une vérification de statut.',
      'Un commerçant peut orienter le routage vers le moins cher, le plus rapide ou le plus fiable, paiement par paiement.',
    ],
    cost: 'Inclus. Vous payez le tarif du rail qui a porté le paiement, et le tableau de bord indique lequel l’a fait.',
    faq: [
      {
        question: 'Une nouvelle tentative pourrait-elle facturer mon client deux fois ?',
        answer:
          'La bascule n’a lieu que pour les erreurs qui garantissent qu’aucun argent n’a bougé. Pour tout ce qui est ambigu — un dépassement de délai, un code inconnu — le statut est vérifié d’abord. Ne pas réessayer vaut mieux que réessayer vers un double débit.',
      },
      {
        question: 'Puis-je forcer un rail particulier ?',
        answer:
          'Vous pouvez orienter la politique de routage vers le moins cher, le plus rapide ou le plus fiable, et restreindre les rails qu’un paiement peut utiliser. Ce que vous ne pouvez pas faire, c’est forcer un rail dont le disjoncteur est ouvert, qui est tout l’intérêt d’en avoir un.',
      },
      {
        question: 'Comment savoir quel rail a été utilisé ?',
        answer: 'Chaque paiement enregistre le connecteur qui l’a porté, ainsi que les tentatives précédentes. Le tableau de bord montre le chemin réellement emprunté, pas celui qui était prévu.',
      },
    ],
    articleSlug: 'smart-route-explique',
    article: `La plupart des intégrations de paiement contiennent une décision que personne ne revisite : le prestataire choisi la première semaine.

Cela fonctionne. Puis une nuit, cela ne fonctionne plus — pas en panne, juste lent et échouant un paiement sur cinq — et chaque paiement se dégrade avec lui. L’entreprise l’apprend par ses clients.

## Le routage est un problème de mesure

Un paiement peut généralement passer par plusieurs chemins. Ces chemins ne valent pas la même chose, et celui qui est le meilleur change d’heure en heure.

La question n’est donc pas *quel prestataire avons-nous choisi* mais *lequel de ceux-ci peut porter ce paiement, maintenant, au mieux*.

## Noté sur ce qui s’est réellement passé

Chaque connecteur candidat est noté sur trois choses mesurées : son **taux de succès** récent, le **coût total** de son usage, et sa **latence** observée.

Ces chiffres viennent d’une télémétrie conservée par tranches de quinze minutes sur vingt-quatre heures — éventuellement indexée par tranche de montant et par préfixe, parce qu’un rail excellent pour de petits paiements locaux ne l’est pas nécessairement pour de gros.

C’est une mesure, pas une liste de préférences écrite une fois.

## Le disjoncteur

Un connecteur qui échoue de façon répétée voit son circuit **ouvert** : il cesse d’être proposé.

Après un délai, il passe en **demi-ouvert** — un paiement est autorisé à passer comme test. S’il réussit, le circuit se ferme et le trafic normal reprend. S’il échoue, retour à ouvert.

L’effet est qu’un rail qui se rétablit est testé avec un seul paiement plutôt qu’avec tous vos clients.

## Une bascule qui ne débitera pas deux fois

C’est là qu’une logique naïve de nouvelle tentative fait de vrais dégâts.

La bascule a lieu **uniquement** pour les erreurs qui garantissent qu’aucun argent n’a bougé. Pour tout ce qui est ambigu — un dépassement de délai, un code de réponse inconnu — le statut est vérifié d’abord.

Un paiement qui a peut-être réussi n’est pas réessayé. Perdre une vente par prudence est récupérable. Débiter un client deux fois, c’est un remboursement, une réclamation et une réputation.

## Votre politique

Un commerçant peut orienter le routage vers le **moins cher**, le **plus rapide** ou le **plus fiable**, et restreindre les rails qu’un paiement peut utiliser.

Ce que vous ne pouvez pas faire, c’est forcer un rail dont le disjoncteur est ouvert. Ce n’est pas une limite ; c’est toute la valeur d’avoir un disjoncteur.

## Vous pouvez voir ce qui s’est passé

Chaque paiement enregistre le connecteur qui l’a porté et les tentatives précédentes. Le tableau de bord montre le chemin réellement emprunté — pas celui qui était prévu, qui est le chiffre que la plupart des systèmes vous donnent et celui qui ne sert à rien pendant un incident.

## Ce que cela coûte

Rien de plus. Vous payez le tarif du rail qui a porté le paiement, et le tableau de bord vous dit lequel l’a fait.`,
  },

  'national-switch': {
    name: 'Raccordement au switch national',
    tagline: 'Conçu pour se raccorder, et conçu pour être testé d’abord.',
    headline: 'Comment construire pour un switch auquel on n’est pas encore raccordé',
    excerpt:
      'Attendre qu’un système publie son profil avant d’écrire la moindre ligne gaspille un an. Écrire contre un contrat interne, avec un simulateur pour les cas pénibles, fait du raccordement un codec plutôt qu’une reconstruction.',
    usp: 'Un adaptateur écrit contre un contrat interne plutôt que contre un protocole, avec un simulateur qui reproduit les cas pénibles — un dépassement de délai après un effet financier, un rejet tardif contradictoire — avant qu’un raccordement réel n’existe.',
    audience: 'Banques, émetteurs de monnaie électronique et institutions qui doivent atteindre ou rejoindre un système national, et les régulateurs qui les supervisent.',
    problem:
      'Les intégrations à un système sont d’habitude écrites contre son protocole. Quand le profil change, ou qu’un deuxième système apparaît, la logique métier doit être réécrite parce que le protocole s’y était infiltré.',
    how: [
      'Les paiements sont exprimés dans une forme canonique interne qui ne présume aucun protocole particulier.',
      'Un adaptateur traduit entre cette forme et ce que le système parle réellement.',
      'Un simulateur reproduit les issues pénibles, étiquetées comme simulation de bout en bout.',
      'Le codec certifié n’est chargé que pour un raccordement dont la certification est enregistrée.',
    ],
    proof: [
      'Le contrat interne ne présume rien du format de transport — ni ISO 8583, ni ISO 20022, ni REST — de sorte que le protocole n’atteint jamais la logique métier.',
      'Le simulateur reproduit un dépassement de délai après un effet financier, un introuvable provisoire, un succès en double, un rejet tardif contradictoire, une signature invalide et un accusé de réception sans aboutissement.',
      'Tout ce que le simulateur produit est étiqueté comme simulation et il n’atteste jamais d’une certification.',
      'Un adaptateur certifié n’est chargé que pour un raccordement dont l’état de certification le dit.',
      'Les frais d’agrégation sur les paiements du switch sont provisionnés par paiement abouti et facturés par période, jamais enregistrés sur le paiement lui-même.',
    ],
    cost: 'Les frais de système et d’agrégation sont définis dans la console et apparaissent sur le relevé du commerçant comme leur propre ligne.',
    faq: [
      {
        question: 'Pourquoi construire avant la publication du profil ?',
        answer:
          'Parce que le difficile n’est pas le format de transport — c’est le comportement autour : ce qui se passe lors d’un dépassement de délai qui a eu un effet financier, ou d’un rejet qui contredit un succès antérieur. Cela peut être construit et testé dès maintenant, et le format devient un codec plus tard.',
      },
      {
        question: 'Le simulateur prouve-t-il que vous êtes certifiés ?',
        answer:
          'Non, et il le dit sur tout ce qu’il produit. Il prouve que le comportement a été construit et testé. La certification est un état distinct et enregistré, et l’adaptateur certifié ne se charge que pour un raccordement qui l’a.',
      },
      {
        question: 'Comment les frais du switch sont-ils facturés ?',
        answer:
          'Provisionnés par paiement abouti et facturés par période et par devise. Ils ne sont jamais enregistrés sur le paiement lui-même : le montant du paiement est le montant du paiement et les frais sont une obligation distincte et visible.',
      },
    ],
    articleSlug: 'raccordement-au-switch-national-explique',
    article: `Il y a deux façons de construire pour un système national auquel on n’est pas encore raccordé.

La courante : attendre le profil, puis écrire l’intégration contre lui. C’est prudent, cela coûte un an, et au bout de l’année on découvre les problèmes intéressants pour la première fois.

## Le protocole est la partie facile

Traduire entre des formats de messages est du travail, mais c’est du travail connu. N’importe quelle équipe compétente le fait une fois la spécification disponible.

Le difficile est le comportement sur les bords, et rien de cela ne dépend du format :

- Le switch **dépasse le délai** — mais l’argent a bougé.
- Un paiement est signalé **introuvable**, provisoirement, puis retrouvé.
- Un **succès en double** arrive pour quelque chose déjà réglé.
- Un **rejet tardif** contredit un succès sur lequel vous avez déjà agi.
- Un accusé de réception arrive **sans aboutissement** derrière lui.

Chacune de ces situations est une décision sur de l’argent, et chacune peut être conçue, construite et testée avant que quiconque ne publie quoi que ce soit.

## Un contrat interne

Les paiements sont exprimés dans une forme canonique interne qui ne présume rien du transport : ni ISO 8583, ni ISO 20022, ni REST, ni SOAP.

Un adaptateur traduit entre cette forme et ce que le système parle. Le protocole n’atteint jamais la logique métier, ce qui a deux conséquences :

1. Un changement de profil est un changement de codec.
2. Un deuxième système, dans un deuxième pays, est un deuxième adaptateur plutôt qu’une deuxième plateforme.

## Le simulateur est fait pour les cas pénibles

Notre simulateur ne simule pas un paiement réussi, cas facile qui ne vous apprend rien.

Il reproduit le dépassement de délai après un effet financier. L’introuvable provisoire. Le succès en double. Le rejet tardif contradictoire. La signature invalide. L’accusé de réception sans rien derrière. L’autorisation qui n’aboutit jamais.

Ce sont les scénarios qui, rencontrés pour la première fois en production, se transforment en un mois de rapprochement et une conversation difficile avec un régulateur.

## Il ne fait jamais semblant

Tout ce que le simulateur produit est étiqueté comme simulation, et il n’atteste jamais d’une certification.

C’est une ligne délibérée. Un simulateur que l’on pourrait prendre pour un raccordement certifié est un risque — pour nous, et pour quiconque lirait un rapport qui en serait issu. La certification est un état distinct et enregistré, et l’adaptateur certifié ne se charge que pour un raccordement qui l’a.

## Les frais restent hors du paiement

Les frais d’agrégation sur les paiements du switch sont provisionnés par paiement abouti et facturés par période et par devise.

Ils ne sont jamais enregistrés sur le paiement lui-même. Le montant du paiement est le montant du paiement ; les frais sont une obligation distincte et visible sur un relevé. Un commerçant peut voir ce qu’on lui a facturé sans le reconstituer depuis un montant net.`,
  },

  'virtual-cards': {
    name: 'Cartes virtuelles',
    tagline: 'Un numéro de carte, sans carte bancaire.',
    headline: 'Internet demande toujours un numéro de carte',
    excerpt:
      'La moitié d’internet refuse le mobile money et exige seize chiffres. Une carte virtuelle émise sur votre propre solde comble cet écart, avec un plafond de dépense et aucun plastique à perdre.',
    usp: 'Un numéro de carte pour les sites qui n’acceptent que les cartes, émis sur votre propre solde, les données de la carte n’étant jamais conservées par BitriPay sous une forme qui pourrait lui être soustraite.',
    audience:
      'Toute personne qui achète en ligne avec un portefeuille mais sans carte bancaire : indépendants qui paient des logiciels, étudiants qui paient des frais, commerçants qui achètent du stock sur des sites étrangers.',
    problem:
      'Le mobile money est la façon dont les gens se paient ici, et ce n’est pas la façon dont internet encaisse. Énormément de services en ligne ne peuvent simplement pas être achetés sans un numéro de carte, quoi que vous déteniez par ailleurs.',
    how: [
      'Créez une carte sur votre solde et fixez-lui un plafond.',
      'Utilisez-la là où un numéro de carte est exigé.',
      'Chaque paiement est autorisé face au solde derrière elle : elle ne peut pas dépenser un argent que vous n’avez pas.',
      'Gelez ou détruisez la carte à tout moment ; le solde reste chez vous.',
    ],
    proof: [
      'Les données de carte sont traitées de sorte que BitriPay ne conserve pas les valeurs sensibles sous une forme qui pourrait lui être soustraite.',
      'Une carte est adossée à votre solde : un paiement par carte ne peut pas dépasser ce qui s’y trouve réellement.',
      'Une carte peut être gelée ou détruite instantanément, et la détruire ne touche pas à l’argent derrière elle.',
      'Une carte distincte par abonnement confine une fuite ou un commerçant indélicat à cette seule carte.',
    ],
    cost: 'L’émission et l’usage sont tarifés dans le tableau de bord avant que vous n’en créiez une, y compris tout frais de devise étrangère : le coût d’un achat est connu avant qu’il ne soit fait.',
    faq: [
      {
        question: 'Pourquoi utiliserais-je plusieurs cartes ?',
        answer:
          'Une par abonnement confine tout problème à une seule carte. Une fuite, un commerçant qui refuse de vous laisser résilier, une hausse de prix que vous n’avez pas acceptée — détruisez cette carte et le problème s’arrête, sans toucher à rien d’autre que vous payez.',
      },
      {
        question: 'Peut-elle être à découvert ?',
        answer: 'Non. Chaque paiement est autorisé face au solde derrière la carte : elle ne peut pas dépenser un argent qui n’y est pas. Le mode de défaillance est une carte refusée, pas une dette.',
      },
      {
        question: 'J’ai perdu mon téléphone.',
        answer:
          'Gelez la carte depuis n’importe quel autre appareil où vous pouvez vous connecter. Une carte virtuelle n’a aucun plastique à perdre, ce qui constitue l’essentiel de son avantage de sécurité.',
      },
    ],
    articleSlug: 'cartes-virtuelles-explique',
    article: `Internet a été construit sur des numéros de carte et ne s’en est jamais vraiment remis.

Vous pouvez détenir un solde parfaitement valable, utilisable dans toutes les boutiques de votre ville, et être tout de même incapable d’acheter un abonnement logiciel, un billet d’avion ou un manuel, parce que la page de paiement veut seize chiffres et une date.

## L’écart

Le mobile money est la façon dont les gens se paient ici. Ce n’est pas la façon dont internet encaisse. Ces deux phrases décrivent l’essentiel de la frustration d’être en ligne dans cette région avec de l’argent qui fonctionne partout sauf là où vous en avez besoin.

Une carte virtuelle comble l’écart. C’est un numéro de carte émis sur votre propre solde — pas de compte bancaire, pas d’examen de crédit, pas de plastique.

## Elle ne peut pas être à découvert

Chaque paiement est autorisé face au solde derrière la carte. Il n’y a rien à dépenser au-delà de ce qui s’y trouve.

Le mode de défaillance est une **carte refusée**, ce qui est agaçant pendant un après-midi. L’autre mode de défaillance, sur un produit de crédit, est une **dette**, qui est un problème d’une tout autre nature.

Pour la plupart des gens, une carte qui peut être refusée est considérablement plus sûre qu’une carte qui ne peut pas l’être.

## Utilisez-en plusieurs

C’est l’habitude à prendre : une carte distincte pour chaque abonnement.

Une carte pour vos logiciels. Une pour le service de streaming. Une pour le site dont vous n’êtes pas sûr.

Ainsi, quand quelque chose tourne mal — une fuite, un commerçant qui rend la résiliation impossible, une hausse de prix que personne n’a acceptée — vous détruisez **cette** carte. Le problème s’arrête immédiatement et rien d’autre de ce que vous payez n’est perturbé.

Comparez avec une seule carte bancaire qui alimente quinze abonnements, où résilier une chose veut dire remplacer la carte et la ressaisir à quatorze endroits.

## Geler de n’importe où

Téléphone perdu ? Gelez la carte depuis n’importe quel appareil où vous pouvez vous connecter.

Il n’y a aucun plastique à perdre au départ, ce qui supprime une catégorie entière de risque que la version physique porte par conception.

## Au sujet des données de carte

Les données de carte sont traitées de sorte que BitriPay ne conserve pas les valeurs sensibles sous une forme qui pourrait lui être soustraite.

C’est une phrase délibérément précise. L’affirmation de sécurité la plus forte que quiconque puisse honnêtement faire au sujet de données de carte stockées, c’est qu’il ne stocke pas la partie qui compte — et toute entreprise qui vous dit que ses données de carte stockées sont inviolables vous dit quelque chose que personne ne peut savoir.

## Ce que cela coûte

L’émission et l’usage sont tarifés dans le tableau de bord avant que vous ne créiez une carte, y compris tout frais de devise étrangère. Vous savez ce que coûte un achat avant de le faire.`,
  },

  'restricted-wallets': {
    name: 'Portefeuilles affectés',
    tagline: 'Donner de l’argent pour un usage, pas seulement à une personne.',
    headline: 'Donner de l’argent qui ne peut être dépensé que pour ce qu’il était destiné',
    excerpt:
      'Parents, employeurs, ONG et programmes publics affrontent tous le même problème : l’argent donné pour une chose est dépensé pour une autre. Un portefeuille qui refuse le mauvais achat le résout sans que personne ne vérifie de reçus.',
    usp: 'De l’argent qui ne peut être dépensé que pour ce qu’il a été donné, appliqué à l’écriture plutôt que confié à la bonne volonté du bénéficiaire — pour qu’une allocation scolaire achète des choses scolaires.',
    audience: 'Parents qui envoient une pension, employeurs qui paient des frais, ONG qui distribuent de l’aide, programmes publics et coopératives.',
    problem:
      'L’argent donné pour des frais de scolarité, des médicaments ou des semences devient fongible dès qu’il atterrit. Les contrôles habituels sont des reçus collectés après coup, ce qui est lent, humiliant et facile à contourner.',
    how: [
      'Créez un portefeuille affecté et dites pour quoi il peut être dépensé — quels commerçants, quelles catégories.',
      'Alimentez-le comme n’importe quel autre portefeuille.',
      'Un achat hors de l’affectation est refusé à l’écriture, pas signalé après coup.',
      'Le détenteur voit à quoi sert le portefeuille : un refus est compris plutôt que mystérieux.',
    ],
    proof: [
      'L’affectation est appliquée comme une politique d’écriture : un achat hors de son périmètre est refusé plutôt qu’enregistré puis revu plus tard.',
      'Le détenteur peut voir l’affectation : un refus s’explique lui-même au lieu de ressembler à une panne.',
      'Un portefeuille affecté est un portefeuille sur le même grand livre, avec les mêmes relevés et le même rapprochement.',
      'Les affectations sont de la configuration sur le portefeuille : un programme peut changer ce qui est permis sans mise en production.',
    ],
    cost: 'Aucun frais pour créer ou détenir des portefeuilles affectés. Les paiements qui en partent portent le tarif ordinaire.',
    faq: [
      {
        question: 'N’est-ce pas paternaliste ?',
        answer:
          'Cela peut l’être, et celui qui crée le portefeuille devrait y réfléchir. C’est aussi ce qui fait exister certains financements : un employeur, un bailleur ou un programme qui ne peut pas donner d’espèces peut souvent donner des fonds affectés. L’alternative est fréquemment rien plutôt que de l’argent libre.',
      },
      {
        question: 'Que voit le détenteur ?',
        answer:
          'À quoi sert le portefeuille. Un refus s’explique alors de lui-même — « ce portefeuille est pour les dépenses scolaires » — au lieu de ressembler à un paiement cassé, ce qui fait la différence entre un contrôle et une humiliation.',
      },
      {
        question: 'L’affectation peut-elle être modifiée plus tard ?',
        answer: 'Oui, par celui qui administre le portefeuille. C’est de la configuration : un programme peut élargir ou resserrer ce qui est permis sans attendre une mise en production.',
      },
    ],
    articleSlug: 'portefeuilles-affectes-explique',
    article: `Un parent envoie à un étudiant de l’argent pour des frais et des livres. Un employeur avance de l’argent pour un déplacement. Une ONG distribue de l’argent pour des semences avant la saison des semis.

Dans chaque cas l’argent est donné **pour** quelque chose, et à l’instant où il atterrit ce n’est plus que de l’argent.

## Le contrôle habituel, et pourquoi il échoue

Collecter les reçus après coup.

C’est lent, c’est humiliant pour le bénéficiaire, cela arrive bien trop tard pour changer quoi que ce soit, et c’est trivialement contourné par quiconque le souhaite. Cela empoisonne aussi la relation : l’étudiant est un suspect, le salarié est audité, l’agriculteur est inspecté.

## Refuser à l’écriture

Un portefeuille affecté porte ce pour quoi il peut être dépensé — quels commerçants, quelles catégories.

Un achat hors de ce périmètre est **refusé à l’écriture**. Pas enregistré puis revu. Pas signalé pour que quelqu’un le poursuive le mois prochain. Refusé, sur l’instant, avant que rien ne bouge.

Personne ne collecte de reçus parce qu’il n’y a rien à vérifier. Le contrôle a eu lieu au lieu de l’achat.

## Le détenteur sait

C’est ce qui décide si la fonctionnalité est digne ou insultante.

Le détenteur du portefeuille peut voir à quoi il sert. Ainsi, quand un achat est refusé, le téléphone dit *ce portefeuille est pour les dépenses scolaires* — et la personne comprend immédiatement, au lieu de rester devant un comptoir avec un paiement qui a échoué sans raison visible.

Un contrôle que son sujet peut voir est une règle. Un contrôle qu’il ne peut pas voir est un piège.

## C’est honnêtement paternaliste

Cela mérite d’être dit franchement, parce que prétendre le contraire serait malhonnête.

Restreindre la façon dont quelqu’un peut dépenser de l’argent est une contrainte sur lui, et celui qui crée le portefeuille devrait se demander si elle est justifiée.

Le contre-argument est simplement que l’argent affecté existe fréquemment là où l’argent libre n’existe pas. Un employeur qui ne peut pas remettre d’espèces peut souvent donner un portefeuille de frais. Un bailleur soumis à des obligations de reporting peut financer un programme affecté et pas un programme libre. Pour le bénéficiaire, la vraie comparaison n’est généralement pas *argent affecté contre argent libre* — c’est *argent affecté contre rien*.

## Toujours un portefeuille ordinaire

Un portefeuille affecté se trouve sur le même grand livre que tous les autres, avec les mêmes relevés et le même rapprochement. L’affectation est une politique sur l’écriture, pas un système séparé avec ses propres livres.

## Ce que cela coûte

Rien à créer ni à détenir. Les paiements qui en partent portent le tarif ordinaire.`,
  },

  savings: {
    name: 'Épargne par objectif',
    tagline: 'De l’argent qui porte un nom.',
    headline: 'On épargne mieux quand l’argent est hors de portée',
    excerpt: 'Le plus dur dans l’épargne n’est pas de gagner plus ; c’est de ne pas dépenser ce qu’on a déjà mis de côté. Un solde séparé avec l’objectif écrit dessus fait l’essentiel de ce travail.',
    usp: 'Une épargne gardée dans un solde séparé avec un objectif nommé, pour que l’argent soit à l’écart des dépenses quotidiennes — et décrite honnêtement comme un solde mis de côté et non comme un compte rémunéré.',
    audience: 'Toute personne qui épargne pour quelque chose de précis : frais de scolarité, stock, un acompte, un mariage, un fonds d’urgence.',
    problem:
      'L’argent épargné à l’intérieur d’un solde de dépense se dépense. Pas par faiblesse — par l’arithmétique ordinaire d’une semaine difficile, où l’argent est juste là et le besoin est maintenant.',
    how: [
      'Créez un objectif avec un nom et, si vous le souhaitez, une cible.',
      'Déplacez-y de l’argent ; il quitte votre solde dépensable.',
      'L’objectif montre ce qui a été mis de côté et à quelle distance il se trouve.',
      'Reprenez-le dès que vous en avez besoin — c’est votre argent, mis à l’écart, pas enfermé.',
    ],
    proof: [
      'Un solde d’objectif est détenu à l’écart du solde dépensable : il n’apparaît pas comme de l’argent disponible à dépenser.',
      'Il est sur le même grand livre avec les mêmes relevés — épargner est une mise à l’écart, pas un produit séparé avec des livres séparés.',
      'L’argent est à vous et retirable ; rien n’est enfermé et rien n’est prêté.',
      'Un objectif est décrit comme un solde mis de côté, pas comme un compte rémunéré ou de placement, parce qu’il n’en est pas un.',
    ],
    cost: 'Gratuit à créer et à détenir. Faire entrer et sortir de l’argent d’un objectif est un mouvement à l’intérieur de votre propre compte.',
    faq: [
      {
        question: 'Est-ce que cela rapporte des intérêts ?',
        answer:
          'Non, et nous ne laisserons pas croire le contraire. C’est un solde mis de côté : votre propre argent, détenu à l’écart de votre solde de dépense pour qu’il soit plus difficile à dépenser par accident. Tout ce qui décrit un produit comme celui-ci comme produisant des rendements décrit autre chose.',
      },
      {
        question: 'Puis-je le retirer plus tôt ?',
        answer:
          'Quand vous voulez. C’est votre argent. La séparation est psychologique et pratique, pas un verrou — et un produit d’épargne qui piège les gens n’est pas un produit que nous voulons exploiter.',
      },
      {
        question: 'Pourquoi un solde séparé aide-t-il, au fond ?',
        answer:
          'Parce que le moment le plus dur de l’épargne est un mardi difficile où l’argent est visible au même endroit que celui où vous payez votre déjeuner. Le déplacer quelque part qui porte un nom ajoute une étape délibérée, et une étape délibérée suffit généralement.',
      },
    ],
    articleSlug: 'epargne-par-objectif-explique',
    article: `Presque personne n’échoue à épargner par ignorance du fait qu’il faudrait le faire. On échoue un mardi, quand quelque chose est nécessaire maintenant et que l’argent mis de côté se trouve dans le même solde que celui qui paie le déjeuner.

Ce n’est pas de la faiblesse. C’est de l’arithmétique. L’argent est là, le besoin est réel, et l’épargne n’était défendue par rien d’autre qu’une intention.

## Un nom et un autre endroit

Un objectif est un solde séparé qui porte un nom : *frais de scolarité*, *nouveau congélateur*, *urgence*.

L’argent que vous y déplacez quitte votre solde dépensable. Il n’apparaît pas quand vous décidez ce que vous pouvez vous permettre, parce qu’il ne l’est pas, au sens qui compte, disponible.

C’est presque tout le mécanisme, et il fonctionne mieux qu’il n’en a le droit. L’étape de reprendre délibérément l’argent **hors** de l’objectif est une friction suffisante pour faire s’arrêter et réfléchir la plupart des gens — et s’arrêter pour réfléchir est tout le combat.

## Rien n’est enfermé

Vous pouvez le reprendre quand vous voulez. C’est votre argent.

La séparation est pratique et psychologique, pas un verrou. Un produit d’épargne qui piège les gens est un produit qui gagne de l’argent sur leurs urgences, et ce n’est pas un métier qui vaille la peine d’être exercé.

## Cela ne rapporte pas d’intérêts, et nous ne le laisserons pas croire

Un objectif est un **solde mis de côté** : votre propre argent, détenu à l’écart de votre solde de dépense.

Il ne rapporte pas d’intérêts. Il n’est pas placé. Il n’est pas prêté pendant que vous ne regardez pas.

Quiconque décrit un produit comme celui-ci avec des mots comme *rendement*, *croissance* ou *performance* décrit quelque chose de matériellement différent, et la différence finira par compter pour quelqu’un qui n’a pas lu attentivement.

## Même grand livre, mêmes relevés

Un objectif est sur le même grand livre que tout le reste, avec les mêmes relevés et le même rapprochement. C’est une mise à l’écart, pas un produit séparé avec des livres séparés qu’il faudrait tenir en phase.

## Comment l’utiliser réellement

Deux choses fonctionnent mieux que n’importe quelle fonctionnalité :

**Déplacez l’argent le jour où il arrive**, pas à la fin de la semaine. Ce qui est encore là le vendredi n’a jamais vraiment été épargné.

**Donnez-lui un nom précis.** *Frais de scolarité, janvier* se défend un mardi difficile d’une façon que *épargne* ne fait pas.

## Ce que cela coûte

Rien à créer ni à détenir.`,
  },

  'bills-and-topup': {
    name: 'Factures, crédit téléphonique et bons',
    tagline: 'Payé veut dire confirmé, pas tenté.',
    headline: 'Quand un paiement de facture échoue, où va l’argent ?',
    excerpt:
      'Acheter du crédit téléphonique ou payer une facture est la transaction numérique la plus courante, et l’endroit où l’argent se bloque le plus souvent. Confirmer sur preuve — et le rendre automatiquement quand la preuve n’arrive pas — est toute la fonctionnalité.',
    usp: 'Une exécution confirmée par la preuve du facturier ou de l’opérateur avant d’être déclarée faite, avec l’argent rendu automatiquement quand la confirmation n’arrive jamais.',
    audience: 'Toute personne qui paie un service public, achète du crédit ou des données, ou recharge le téléphone de quelqu’un d’autre.',
    problem:
      'L’argent part, le crédit n’arrive pas, et on dit au client d’attendre puis de contacter l’opérateur. La transaction reste en suspens parce que rien dans le système ne décide quoi en faire.',
    how: [
      'Choisissez le facturier ou l’opérateur, le compte ou le numéro et le montant.',
      'L’écran affiche le total, frais compris, avant votre confirmation.',
      'Le paiement aboutit quand le facturier ou l’opérateur confirme l’exécution.',
      'Si la confirmation n’arrive pas dans le délai, l’argent est rendu au lieu d’être laissé en attente.',
    ],
    proof: [
      'L’exécution est confirmée face à la preuve du facturier ou de l’opérateur, pas supposée depuis une requête réussie.',
      'Une transaction sans confirmation est annulée par une écriture en sens inverse plutôt que laissée indéfiniment en attente.',
      'Les frais sont affichés avant la confirmation : le total est connu avant que l’argent ne bouge.',
      'La référence apparaît sur le relevé et sur l’enregistrement d’exécution : une recharge contestée peut être retracée au lieu d’être disputée.',
    ],
    cost: 'Le montant plus tout frais, les deux affichés avant votre confirmation. Lorsqu’un facturier fixe ses propres frais, ils apparaissent comme leur propre ligne.',
    faq: [
      {
        question: 'J’ai payé et le crédit n’est jamais arrivé.',
        answer:
          'Si l’exécution n’a pas été confirmée dans le délai, l’argent est rendu à votre solde automatiquement et la tentative comme le retour apparaissent sur votre relevé. S’il s’affiche comme confirmé et que le crédit manque réellement, la référence sur le relevé est ce dont l’opérateur a besoin pour le retracer.',
      },
      {
        question: 'Puis-je recharger le numéro de quelqu’un d’autre ?',
        answer: 'Oui. Saisissez son numéro au lieu du vôtre. La référence sur votre relevé enregistre quel numéro a été rechargé, ce qui règle la plupart des disputes sur l’envoi.',
      },
      {
        question: 'Pourquoi y a-t-il parfois un délai ?',
        answer:
          'Parce que le paiement attend la confirmation du facturier ou de l’opérateur, au lieu d’être déclaré fait sur une requête optimiste. Cette attente est la raison pour laquelle l’argent n’est pas perdu quand quelque chose tourne mal.',
      },
    ],
    articleSlug: 'factures-credit-telephonique-et-bons-explique',
    article: `Acheter du crédit téléphonique est la transaction numérique la plus courante de la région. C’est aussi l’endroit où l’argent disparaît discrètement pendant une semaine le plus souvent.

Le schéma est familier à tout le monde : le solde baisse, le crédit n’arrive pas, l’application affiche *en attente*, et quelqu’un vous suggère de contacter l’opérateur.

## Pourquoi cela se bloque

La plupart des systèmes traitent la requête comme l’événement. Ils envoient l’instruction, elle est acceptée, et ils marquent le paiement comme fait.

Mais accepté n’est pas exécuté. Si l’opérateur ne crédite jamais réellement le numéro, il existe désormais une transaction que la plateforme croit réussie et dont le client sait qu’elle ne l’est pas — et rien dans le système n’est responsable de trancher ce désaccord.

Alors cela reste là. « En attente pour toujours » n’est pas un état que quelqu’un a conçu ; c’est ce que l’on obtient quand personne n’a décidé ce qui devait se passer.

## Confirmé, ou rendu

Ici, le paiement aboutit quand le facturier ou l’opérateur **confirme l’exécution**.

Et si la confirmation n’arrive pas dans le délai, l’argent est **rendu** — par une écriture en sens inverse, automatiquement, sans que personne n’ouvre un ticket.

La tentative comme le retour apparaissent sur votre relevé. Vous voyez ce qui s’est passé au lieu d’avoir à demander ce qui s’est passé.

C’est toute la fonctionnalité. Elle n’est pas astucieuse. C’est juste la chose que quelqu’un doit décider à l’avance, et que la plupart des systèmes ne décident jamais.

## Le total avant votre confirmation

Le montant plus tout frais est affiché avant que l’argent ne bouge. Lorsqu’un facturier fixe ses propres frais, ils forment leur propre ligne au lieu d’être fondus dans le total.

Vous ne devriez pas apprendre le coût d’une transaction sur votre relevé après coup.

## Recharger quelqu’un d’autre

Saisissez son numéro au lieu du vôtre. Votre relevé enregistre quel numéro a été rechargé.

Cet enregistrement règle la dispute qui suit environ une recharge sur cinquante — *je l’ai envoyé*, *je ne l’ai pas reçu* — avec un fait au lieu de deux souvenirs.

## Quand cela tourne réellement mal

Si une recharge s’affiche comme confirmée et que le crédit manque vraiment, la référence sur votre relevé est ce dont l’opérateur a besoin pour la retracer de son côté.

Vous ne leur demandez pas de vous croire sur parole. Vous leur donnez la référence que leur propre système a émise.

## Ce que cela coûte

Le montant, plus tout frais, les deux affichés avant votre confirmation.`,
  },

  'p2p-marketplace': {
    name: 'Place de marché entre particuliers',
    tagline: 'Échanger avec un inconnu, en sécurité.',
    headline: 'Échanger avec quelqu’un que vous n’avez jamais rencontré',
    excerpt:
      'Tout échange entre particuliers porte le même bras de fer : celui qui bouge le premier peut être trompé. Le séquestre supprime le bras de fer, et une procédure de litige avec les preuves déjà attachées supprime l’essentiel de ce qui suit.',
    usp: 'Des échanges entre particuliers où l’argent est détenu en séquestre jusqu’à ce que les deux côtés aient fait leur part, et où un litige va à un humain avec les preuves déjà attachées.',
    audience: 'Toute personne qui achète ou vend entre particuliers : devises, biens, services, tout ce qui s’arrange entre deux personnes qui ne se connaissent pas.',
    problem:
      'Un côté doit y aller le premier. Celui-là porte tout le risque, et la résolution habituelle — discuter dans une conversation, puis renoncer — favorise celui qui est le plus disposé à mal se comporter.',
    how: [
      'Convenez de l’échange et ouvrez-le ; l’argent de l’acheteur part en séquestre.',
      'Le vendeur voit que l’argent est détenu, donc il livre.',
      'L’acheteur confirme, et le séquestre se libère vers le vendeur.',
      'En cas de désaccord, cela part en litige où une personne examine les preuves attachées à l’échange.',
    ],
    proof: [
      'L’argent en séquestre est détenu sur le grand livre, pas détenu comme une promesse — les deux côtés voient qu’il y est.',
      'La libération exige la confirmation de l’acheteur ou une décision de litige ; aucun des deux côtés ne peut le prendre unilatéralement.',
      'Un litige porte les preuves et l’historique propres de l’échange : un examinateur ne les reconstitue pas à partir de captures d’écran.',
      'L’historique de la contrepartie est visible : un schéma de litiges est apparent avant un échange plutôt qu’après.',
    ],
    cost: 'Les frais d’un échange abouti sont affichés avant son ouverture. Un échange annulé avant livraison rend l’argent du séquestre.',
    faq: [
      {
        question: 'Qu’est-ce qui empêche l’acheteur de prendre la marchandise et de refuser de confirmer ?',
        answer:
          'Un litige. Le séquestre ne se libère pas sur un silence — cela part vers une personne qui examine les preuves attachées à l’échange. Un acheteur qui refuse de confirmer un échange livré plaide un dossier qu’il doit gagner, au lieu de simplement repartir avec.',
      },
      {
        question: 'Comment un litige est-il réellement tranché ?',
        answer: 'Par une personne, sur les preuves attachées à l’échange et l’historique des deux parties. Ce n’est pas un algorithme, et ce n’est pas celui qui se plaint le plus fort.',
      },
      {
        question: 'Puis-je voir avec qui j’échange ?',
        answer: 'Vous pouvez voir son historique d’échanges, litiges compris. Un schéma est visible avant d’échanger, ce qui est considérablement plus utile que de le découvrir après.',
      },
    ],
    articleSlug: 'place-de-marche-entre-particuliers-explique',
    article: `Tout échange entre deux personnes qui ne se sont jamais rencontrées contient le même bras de fer.

Si l’acheteur paie d’abord, le vendeur peut garder l’argent. Si le vendeur livre d’abord, l’acheteur peut garder la marchandise. Quelqu’un doit y aller le premier, et celui-là porte tout le risque.

La résolution habituelle est une dispute dans une fenêtre de conversation suivie du renoncement d’une des parties, ce qui favorise systématiquement celui qui est le plus à l’aise avec un mauvais comportement.

## Le séquestre supprime le bras de fer

L’argent de l’acheteur part en séquestre à l’ouverture de l’échange. Il est détenu sur le grand livre — réellement détenu, pas promis — et **les deux côtés voient qu’il y est**.

On ne demande plus au vendeur de faire confiance à l’acheteur. Il voit l’argent. Donc il livre.

L’acheteur confirme, et le séquestre se libère.

Aucun des deux côtés ne peut le prendre unilatéralement, propriété qui fait fonctionner l’ensemble.

## Le silence n’est pas une stratégie

L’attaque évidente : l’acheteur prend livraison et ne confirme simplement jamais.

Le séquestre ne se libère pas sur un silence. Cela part en **litige**, où une personne l’examine.

Un acheteur dans cette position ne repart donc pas discrètement avec la marchandise et l’argent. Il plaide un dossier, devant quelqu’un, qu’il doit gagner. Cela change l’arithmétique de la tentative.

## Des litiges avec les preuves déjà là

Un litige porte l’historique propre de l’échange et les preuves qui y sont attachées. Un examinateur ne réassemble pas les événements à partir de captures envoyées par deux personnes aux intérêts opposés.

C’est tranché par une **personne**, sur ces preuves et sur l’historique des deux parties. Pas par un algorithme, et pas par celui qui se plaint le plus obstinément.

## L’historique est visible avant d’échanger

Vous pouvez voir l’historique d’échanges d’une contrepartie, litiges compris.

Un schéma est apparent **avant** que vous n’échangiez. La plupart des mauvais acteurs ne sont pas astucieux ; ils sont répétitifs, et la répétition est visible quand l’historique l’est.

## Quand l’utiliser

Tout échange avec quelqu’un que vous ne connaissez pas et que vous n’auriez aucun moyen de poursuivre si cela tournait mal — devises, biens, services, tout ce qui s’arrange entre deux particuliers.

Pour un échange avec votre cousin, c’est une lourdeur. Pour un échange arrangé dans un groupe avec un inconnu, c’est la différence entre un échange et un espoir.

## Ce que cela coûte

Les frais d’un échange abouti sont affichés avant son ouverture. Un échange annulé avant livraison rend l’argent du séquestre.`,
  },

  'open-banking': {
    name: 'Connexions bancaires',
    tagline: 'Vos données bancaires, à vos conditions.',
    headline: 'Relier un compte bancaire sans céder les clés',
    excerpt:
      'Les connexions bancaires permettent de payer par virement et de prouver ses revenus sans téléverser de relevés. La question qui mérite d’être posée est ce que vous avez consenti, pour combien de temps, et comment vous le reprenez.',
    usp: 'Relier un compte bancaire pour payer par banque et vérifier ses revenus, avec un consentement explicite, délimité et révocable depuis l’application plutôt qu’enterré sur le site de quelqu’un d’autre.',
    audience: 'Toute personne qui a un compte bancaire et veut l’utiliser pour alimenter, payer, ou prouver ses revenus sans rien imprimer.',
    problem:
      'Les connexions bancaires sont d’habitude acceptées une fois, dans la précipitation, sur un écran que personne ne lit, sans moyen clair de voir plus tard ce qui a été partagé ni de l’arrêter.',
    how: [
      'Reliez le compte via l’autorisation de votre propre banque.',
      'Le consentement nomme ce qui est partagé et pour combien de temps.',
      'Utilisez-le pour payer par banque, ou pour vérifier vos revenus sans téléverser de relevés.',
      'Révoquez-le depuis l’application quand vous le décidez.',
    ],
    proof: [
      'Le consentement est explicite, délimité et limité dans le temps plutôt qu’ouvert.',
      'Il peut être révoqué depuis l’application, pas seulement sur le site de la banque.',
      'La vérification des revenus utilise la connexion au lieu de vous demander de téléverser des documents qu’il faudrait ensuite stocker quelque part.',
      'Un mandat de prélèvement récurrent est un consentement distinct de la lecture du compte, parce que ce sont deux choses différentes.',
    ],
    cost: 'Relier est gratuit. Lorsque payer par banque comporte des frais, ils sont affichés avant votre confirmation.',
    faq: [
      {
        question: 'Que pouvez-vous voir exactement ?',
        answer:
          'Ce que dit le consentement, pour la période qu’il couvre, et rien d’autre. Le consentement nomme son périmètre avant que vous ne l’acceptiez, et vous pouvez le relire ensuite au lieu d’avoir à vous en souvenir.',
      },
      {
        question: 'Comment l’arrêter ?',
        answer:
          'Révoquez-le dans l’application. Cela ne devrait pas exiger de trouver un réglage sur le site de votre banque — un consentement difficile à retirer n’est pas vraiment un consentement.',
      },
      {
        question: 'Un mandat équivaut-il à vous laisser lire mon compte ?',
        answer:
          'Non, et les deux sont tenus séparés délibérément. Lire un compte et être autorisé à y prélever sont des permissions différentes, et accepter l’une ne devrait jamais accorder l’autre en silence.',
      },
    ],
    articleSlug: 'connexions-bancaires-explique',
    article: `Une connexion bancaire est réellement utile. Vous pouvez alimenter un compte sans saisir de référence, payer directement depuis votre banque, et prouver vos revenus sans imprimer six mois de relevés et les porter quelque part.

C’est aussi la permission que les gens accordent avec le moins d’attention, sur un écran conçu pour être cliqué sans lire.

## Trois questions qui méritent d’être posées

À tout service qui demande à se connecter à votre banque :

1. **Que verrez-vous exactement ?**
2. **Pendant combien de temps ?**
3. **Comment j’arrête, et où est ce bouton ?**

Un service incapable de répondre clairement aux trois vous a dit quelque chose sur la façon dont il entend se servir de la réponse.

## Délimité et limité dans le temps

Le consentement nomme ce qui est partagé et pour combien de temps, avant votre accord, et vous pouvez le relire ensuite au lieu de vous fier au souvenir d’un écran vu une fois.

Un consentement ouvert — tout, pour toujours — est la valeur par défaut du secteur et ne devrait pas l’être.

## Révocable là où vous êtes

Révoquez-le **dans l’application**.

Pas en trouvant une page enterrée sur le site de votre banque. Pas en écrivant au support et en attendant. Un consentement difficile à retirer n’est pas un consentement ; c’est une signature que vous ne pouvez pas reprendre, et la difficulté est généralement délibérée.

## Des revenus sans documents

Vérifier ses revenus via la connexion veut dire que vous ne téléversez pas de relevés bancaires — ce qui veut aussi dire que personne n’a à stocker ces relevés, et que personne ne peut les perdre plus tard.

La copie la plus sûre d’un document est celle qui n’a jamais été faite.

## Lire n’est pas prélever

Un **mandat** — la permission de prélever de l’argent sur votre compte selon un calendrier — est un consentement distinct de la lecture du compte.

Les deux sont tenus séparés délibérément. Accepter qu’un service voie votre solde ne devrait jamais inclure en silence qu’il puisse prendre de l’argent, et partout où ces deux choses sont réunies dans une seule case à cocher, quelqu’un a fait un choix que vous n’auriez pas fait.

## Ce que cela coûte

Relier est gratuit. Lorsque payer par banque comporte des frais, ils sont affichés avant votre confirmation.`,
  },

  'credit-readiness': {
    name: 'Préparation au crédit',
    tagline: 'Votre historique, partagé à vos conditions.',
    headline: 'Être invisible pour les prêteurs n’est pas la même chose qu’être un mauvais risque',
    excerpt:
      'Des millions de personnes aux historiques de paiement parfaitement bons ne peuvent pas emprunter, parce que leur historique n’est écrit nulle part où un prêteur puisse le lire. Un signal que vous possédez et choisissez de partager change qui peut être vu.',
    usp: 'Un signal construit à partir de votre propre historique de paiements que vous choisissez de partager avec un prêteur — pas une note détenue sur vous, vendue à votre sujet, et utilisée pour vous refuser sans explication.',
    audience: 'Commerçants et petites entreprises qui ont besoin de fonds de roulement, et les prêteurs qui ne peuvent pas les évaluer aujourd’hui.',
    problem:
      'Une commerçante qui encaisse fiablement depuis trois ans a un historique de précisément cela — et aucun moyen de le montrer à qui que ce soit. Les prêteurs ne voient aucun dossier et refusent, non parce que le risque est mauvais mais parce qu’il est illisible.',
    how: [
      'Votre historique de paiements sur la plateforme produit un signal de préparation.',
      'Vous le voyez, et vous voyez ce qui le fait bouger.',
      'Vous choisissez de le partager ou non avec un prêteur précis.',
      'Le prêteur reçoit le signal que vous avez consenti à partager, pas un dossier qu’il détient sur vous.',
    ],
    proof: [
      'Le signal est informatif et décrit comme tel ; ce n’est pas une note de bureau de crédit et il ne prétend pas en être une.',
      'Il n’est partagé qu’avec votre consentement, avec la partie que vous choisissez, au lieu d’être revendu.',
      'Il est construit à partir de votre propre activité sur la plateforme, que vous pouvez voir dans vos propres relevés.',
      'L’accès d’un prêteur est délimité : lire un signal de préparation partagé est une permission précise, pas un accès général à un compte.',
    ],
    cost: 'Gratuit à consulter et gratuit à partager. BitriPay ne le vend pas, et les frais éventuels d’un prêteur sont une affaire entre vous et lui.',
    faq: [
      {
        question: 'Est-ce une note de crédit ?',
        answer:
          'Non, et la distinction compte. Une note de bureau de crédit est détenue sur vous par quelqu’un d’autre et vendue à qui la demande. Ceci est un signal issu de votre propre activité, que vous voyez, et que vous choisissez de partager avec un prêteur précis.',
      },
      {
        question: 'Peut-il être utilisé contre moi ?',
        answer:
          'Seulement si vous le partagez. Si vous ne le faites jamais, aucun prêteur ne le reçoit. C’est la différence entre un signal que vous contrôlez et un dossier qui existe que cela vous plaise ou non.',
      },
      {
        question: 'Cela va-t-il m’obtenir un prêt ?',
        answer:
          'C’est informatif, pas une décision. Le prêt reste la décision du prêteur selon ses propres critères. Ce que cela change, c’est de savoir si vous avez quelque chose à montrer — ce qui, pour beaucoup de gens, est la vraie barrière.',
      },
    ],
    articleSlug: 'preparation-au-credit-explique',
    article: `Une commerçante encaisse six jours par semaine depuis trois ans. Ses recettes sont stables, sa saison est prévisible, ses clients reviennent.

Elle demande un fonds de roulement et est refusée en moins d’une minute, parce que le prêteur n’a aucun dossier sur elle.

Le refus n’est pas un jugement sur le risque. C’est la constatation que le risque n’a pas pu être lu.

## Invisible n’est pas synonyme de mauvais

C’est la distinction sur laquelle tout repose, et elle se perd constamment.

Un dossier mince veut dire **aucune information**. Les prêteurs, raisonnablement, traitent l’absence d’information comme un risque — et ainsi des millions de personnes aux historiques réellement bons sont indiscernables de personnes aux historiques réellement mauvais.

L’historique existe. Il n’est simplement écrit nulle part où un prêteur puisse le lire.

## Un signal issu de votre propre activité

Votre historique de paiements sur la plateforme produit un signal de préparation. Vous pouvez le voir, et vous pouvez voir ce qui le fait bouger.

Cette seconde partie compte plus qu’il n’y paraît. Un chiffre que vous ne pouvez ni influencer ni interroger n’est pas une information sur laquelle agir — c’est un verdict.

## Vous décidez qui le voit

C’est là que cela diffère d’un bureau de crédit, et cette différence est tout l’enjeu.

La note d’un bureau est détenue **sur** vous par quelqu’un d’autre, et vendue à qui la demande. Vous ne la voyez peut-être pas. Vous ne pouvez généralement pas la corriger. Vous n’avez certainement pas consenti à chaque divulgation.

Ce signal n’est partagé **que quand vous le partagez**, avec le prêteur que vous choisissez. Si vous ne le partagez jamais, aucun prêteur ne le reçoit.

Vos données ne sont pas un produit vendu au-dessus de votre tête.

## Ce n’est pas une décision

C’est informatif, et décrit comme tel.

Le prêt reste la décision du prêteur selon ses propres critères, et quiconque promet qu’une note garantit un crédit vous trompe.

Ce qui change, c’est de savoir si vous avez **quelque chose à montrer**. Pour une commerçante refusée depuis trois ans faute de dossier, ce n’est pas une amélioration marginale. C’est toute la barrière.

## Ce que cela coûte

Gratuit à consulter et gratuit à partager. BitriPay ne le vend pas. Ce qu’un prêteur facture est entre vous et lui.`,
  },

  'gift-cards': {
    name: 'Cartes cadeaux et bons',
    tagline: 'Un code qui ne peut être dépensé qu’une fois.',
    headline: 'Le problème quand on envoie un code à quelqu’un',
    excerpt:
      'Un code de bon dans un message peut être transféré, photographié et utilisé par le premier arrivé. Un bon enregistré sur le grand livre ne peut être utilisé qu’une fois, par une personne, et vous pouvez voir quand.',
    usp: 'Un bon qui est une créance sur l’émetteur enregistrée au grand livre, utilisable une seule fois et traçable — pas un code dans un message qui a peut-être déjà été dépensé par quelqu’un d’autre.',
    audience: 'Toute personne qui offre de l’argent pour une occasion, employeurs qui donnent une prime, entreprises qui mènent des promotions, et ONG qui distribuent de la valeur.',
    problem: 'Un code de bon est une valeur au porteur en clair. Transféré à un groupe, photographié par-dessus une épaule ou intercepté, il est perdu — et personne ne peut prouver qui l’a utilisé.',
    how: [
      'Émettez un bon pour un montant, avec une échéance si vous le souhaitez.',
      'Il est enregistré comme une créance sur l’émetteur, pas seulement comme une chaîne de caractères.',
      'Le détenteur l’utilise vers son solde ; l’utilisation a lieu une seule fois.',
      'Une seconde tentative est refusée, et l’enregistrement montre quand et par qui il a été utilisé.',
    ],
    proof: [
      'Un bon est enregistré au grand livre comme une créance : l’émettre et l’utiliser sont des écritures plutôt qu’un indicateur en base de données.',
      'L’utilisation est à usage unique : une seconde tentative est refusée plutôt qu’ignorée en silence.',
      'L’enregistrement d’utilisation montre quand il a été utilisé et vers quel compte.',
      'La valeur promotionnelle est suivie séparément de la monnaie électronique des clients, parce qu’une dette marketing n’est pas une créance remboursable et ne doit pas être comptée comme telle.',
    ],
    cost: 'L’émission est tarifée dans le tableau de bord avant que vous ne créiez des bons. Les utiliser vers un solde est gratuit pour le détenteur.',
    faq: [
      {
        question: 'Quelqu’un d’autre a utilisé mon code.',
        answer:
          'Un bon est une valeur au porteur : le premier qui l’utilise l’obtient — raison précise pour laquelle il devrait être envoyé à une personne plutôt que publié dans un groupe. L’enregistrement montre quand il a été utilisé et vers quel compte : il peut au moins être retracé.',
      },
      {
        question: 'Un bon peut-il être utilisé deux fois ?',
        answer: 'Non. L’utilisation est à usage unique, et une seconde tentative est refusée plutôt qu’ignorée discrètement. L’échec est visible pour celui qui a tenté.',
      },
      {
        question: 'Pourquoi la valeur promotionnelle est-elle suivie séparément ?',
        answer:
          'Parce qu’un crédit qui vous a été offert en promotion est une dette marketing de la plateforme, et que l’argent que vous avez versé est une créance remboursable. Les compter ensemble surestimerait ce qui est dû aux clients et sous-estimerait ce qui doit être adossé.',
      },
    ],
    articleSlug: 'cartes-cadeaux-et-bons-explique',
    article: `Un code de bon est une valeur au porteur écrite en clair. Celui qui détient la chaîne détient l’argent.

C’est acceptable quand elle voyage d’une personne à une personne. Ce n’est pas acceptable dans un groupe, sur une photo prise par-dessus une épaule, ou dans un message transféré une fois de trop.

## Ce qui tourne mal avec un code nu

L’histoire habituelle : un code est publié dans un endroit un peu trop public. Quelqu’un qui n’était pas le destinataire prévu l’utilise. Le destinataire prévu trouve un code expiré et une conversation que personne ne peut trancher, parce qu’il n’existe aucune trace de qui l’a utilisé.

Le code a parfaitement fait son travail. C’est simplement que ce travail n’a jamais été sûr.

## Une créance au grand livre

Ici, un bon est enregistré comme une **créance sur l’émetteur** — une écriture, pas un indicateur dans une table.

L’émettre est une écriture. L’utiliser est une écriture. Les deux existent dans les livres, donc les deux peuvent être examinées plus tard.

## Utilisé une fois, visiblement

L’utilisation est à usage unique. Une seconde tentative est **refusée**, pas ignorée en silence : la personne qui tente voit que c’est déjà parti au lieu de se demander si l’application fonctionne.

Et l’enregistrement montre quand il a été utilisé et vers quel compte.

Cela ne défait pas un code publié au mauvais endroit — une valeur au porteur reste une valeur au porteur — mais cela transforme *quelqu’un l’a pris et nous ne le saurons jamais* en un fait traçable.

## Envoyez-le à une personne

Le conseil pratique est terne et mérite d’être répété : envoyez un bon à une personne, dans un message à cette personne.

Pas un groupe. Pas une photo. Pas une légende. La sécurité d’un instrument au porteur est entièrement une affaire de qui peut le voir.

## La valeur promotionnelle n’est pas votre argent

Cela mérite une explication, parce que c’est le genre de distinction comptable qui compte énormément et qui est invisible de l’extérieur.

Le crédit que la plateforme vous **offre** en promotion est une dette marketing de la plateforme. L’argent que vous **versez** est une créance remboursable adossée à des fonds cantonnés.

Les deux sont suivis séparément. Les compter ensemble surestimerait ce qui est dû aux clients et sous-estimerait ce qui doit être adossé — et une plateforme qui les mélange est une plateforme dont le chiffre d’adossement n’est pas fiable.

## Ce que cela coûte

L’émission est tarifée dans le tableau de bord avant que vous ne créiez des bons. Les utiliser vers un solde est gratuit pour le détenteur.`,
  },

  referrals: {
    name: 'Parrainage et croissance',
    tagline: 'Payé pour des clients, pas pour des clics.',
    headline: 'Les programmes de parrainage échouent quand ils paient la mauvaise chose',
    excerpt:
      'Payez pour des inscriptions et vous obtenez des inscriptions : des comptes vides, des personnes inventées, et un budget dépensé pour rien. Payer sur un résultat réel, avec une attribution que n’importe qui peut vérifier, fait toute la différence.',
    usp: 'Des récompenses qui paient sur un résultat réel, pas sur une inscription, avec l’attribution et la récompense toutes deux visibles pour la personne qui les a gagnées.',
    audience: 'Commerçants qui grandissent par le bouche-à-oreille, agents qui construisent une clientèle, créateurs et partenaires qui ont une audience.',
    problem:
      'Un programme de parrainage qui paie à l’inscription est une invitation à créer des inscriptions. Le budget part vers celui qui automatise le plus vite, et le parrain sincère qui a amené trois vrais clients reçoit autant qu’un script.',
    how: [
      'Partagez votre lien ou votre code de parrainage.',
      'Une personne qui rejoint par ce biais vous est attribuée.',
      'La récompense paie quand la condition est remplie — un résultat, pas une arrivée.',
      'Vous pouvez voir qui vous a été attribué et ce qui a été gagné.',
    ],
    proof: [
      'L’attribution et les récompenses sont visibles pour le parrain : les gains peuvent être vérifiés au lieu d’être pris sur parole.',
      'Les récompenses sont configurées par programme et payées contre le résultat enregistré, pas contre un événement d’inscription.',
      'Les comptes parrainés passent les mêmes contrôles d’identité que les autres : un parrainage ne peut pas contourner la vérification.',
      'L’attribution des partenaires est enregistrée pour les campagnes : la contribution réelle d’un canal est mesurable plutôt que revendiquée.',
    ],
    cost: 'Les récompenses sont payées par le programme qui les fixe. Parrainer ne coûte rien.',
    faq: [
      {
        question: 'Quand suis-je réellement payé ?',
        answer:
          'Quand la condition fixée par le programme est remplie — un résultat réel plutôt qu’une arrivée. La condition est visible avant que vous ne parrainiez quiconque : vous ne devinez pas ce qui compte.',
      },
      {
        question: 'Puis-je voir si quelqu’un a utilisé mon lien ?',
        answer: 'Oui. L’attribution et les gains vous sont visibles, seule façon pour un programme de parrainage d’être vérifiable plutôt qu’une chose dont on espère qu’elle fonctionne.',
      },
      {
        question: 'Les comptes parrainés sautent-ils la vérification ?',
        answer: 'Non. Un compte parrainé passe exactement les mêmes contrôles d’identité que les autres. Un parrainage est une voie d’entrée, pas un raccourci qui contourne les contrôles.',
      },
    ],
    articleSlug: 'parrainage-et-croissance-explique',
    article: `La plupart des programmes de parrainage paient pour une inscription. La plupart des budgets de parrainage sont donc dépensés en inscriptions, et les inscriptions sont la chose la moins chère au monde à fabriquer.

## Ce qu’on achète en payant des arrivées

Des comptes vides. Des personnes inventées. De vraies personnes persuadées de s’inscrire qui ne reviennent jamais.

L’argent part de façon disproportionnée vers celui qui automatise le plus vite, et la personne qui a réellement parlé d’une chose utile à trois voisins reçoit la même récompense qu’un script — autrement dit, elle cesse de s’en occuper.

Le programme n’a pas échoué parce que le parrainage ne fonctionne pas. Il a échoué parce qu’il payait le mauvais événement.

## Payer sur un résultat

Une récompense ici paie quand la condition fixée par le programme est **remplie** — quelque chose de réel qui se produit, pas quelqu’un qui arrive.

La condition est visible avant que vous ne parrainiez quiconque : vous ne devinez pas ce qui compte pour vous sentir ensuite floué.

C’est plus lent à payer. C’est aussi la seule version où le budget atteint les gens qui font réellement grandir l’entreprise.

## Une attribution que vous pouvez vérifier

Vous pouvez voir qui vous a été attribué et ce qui a été gagné.

Cela paraît mineur et ne l’est pas. Un programme de parrainage dont le fonctionnement est invisible pour le parrain est un programme qu’il doit prendre sur parole, et les gens cessent d’accorder leur confiance à des systèmes qui leur versent des montants imprévisibles pour des raisons qu’ils ne peuvent pas inspecter.

Si quelqu’un a utilisé votre lien et que vous ne pouvez pas le voir, vous supposerez que le système l’a perdu — et vous aurez assez souvent raison pour cesser de parrainer.

## Le parrainage ne saute pas la porte

Un compte parrainé passe exactement les mêmes contrôles d’identité que les autres.

Cela agace parfois les parrains, qui estiment que leur recommandation devrait compter pour quelque chose. Elle devrait, et elle compte — mais pas comme un raccourci qui contourne la vérification, parce qu’une voie de parrainage qui contournerait les contrôles deviendrait immédiatement la voie préférée de tous ceux qui ont une raison de les éviter.

## Pour les partenaires et les campagnes

L’attribution des partenaires est enregistrée pour les campagnes : la contribution réelle d’un canal est mesurable plutôt que revendiquée lors d’une revue trimestrielle par celui qui présente avec le plus d’assurance.

## Ce que cela coûte

Rien pour parrainer. Les récompenses sont payées par le programme qui les fixe.`,
  },

  support: {
    name: 'Support et assistance',
    tagline: 'Des réponses tirées du registre, pas de suppositions.',
    headline: 'Pourquoi le support ne devrait pas pouvoir corriger votre solde',
    excerpt:
      'Le moyen le plus rapide de résoudre une réclamation est de laisser un conseiller ajuster le chiffre. C’est aussi la façon dont les plateformes perdent la capacité de faire confiance à leurs propres livres. Un support qui peut tout lire et ne rien changer est la réponse la plus difficile et la meilleure.',
    usp: 'Un support qui voit le même grand livre et les mêmes événements que vous, pour qu’une réponse soit lue dans le registre plutôt que devinée — et qui ne peut pas modifier votre solde pour faire disparaître un problème.',
    audience: 'Tout client dont un paiement a mal tourné, et tout exploitant qui doit répondre de ce que son équipe de support a fait.',
    problem:
      'On donne aux équipes de support sous pression des outils pour faire disparaître les problèmes. Un conseiller qui peut ajuster un solde peut être manipulé, peut se tromper, et laisse une plateforme incapable de prouver ce qui s’est réellement passé.',
    how: [
      'Ouvrez un ticket, ou discutez là où c’est disponible.',
      'Le conseiller peut voir le paiement, ses tentatives, ses événements et son état.',
      'La réponse est lue dans le registre plutôt qu’estimée.',
      'Lorsque de l’argent doit réellement bouger, c’est une écriture sous les contrôles ordinaires — pas une modification.',
    ],
    proof: [
      'Les conseillers lisent le grand livre et le journal d’événements chaîné par empreinte ; ils ne peuvent pas fixer un solde, parce que les soldes sont déduits des écritures au lieu d’être stockés.',
      'Une correction est une écriture sous les règles ordinaires d’autorité et de quatre yeux : un correctif est aussi auditable que l’original.',
      'Chaque paiement porte ses tentatives et ses changements d’état : un conseiller peut dire ce qui s’est passé plutôt que ce qui s’est probablement passé.',
      'Les actions administratives sont écrites dans la piste d’audit sous le nom propre du conseiller.',
    ],
    cost: 'Le support est inclus. Il n’existe pas de file prioritaire payante qui ferait passer un client au paiement cassé derrière un client qui a payé davantage.',
    faq: [
      {
        question: 'Pourquoi le support ne peut-il pas simplement remettre l’argent ?',
        answer:
          'Parce qu’un conseiller qui peut fixer un solde peut être convaincu de le fixer par quelqu’un qui n’est pas vous, et parce qu’une plateforme dont les soldes sont modifiables ne peut pas prouver ce qu’elle doit à qui que ce soit. Une vraie correction est une écriture, sous les mêmes contrôles que tout autre mouvement.',
      },
      {
        question: 'Saura-t-il réellement ce qui est arrivé à mon paiement ?',
        answer:
          'Il peut voir le paiement, chaque tentative, chaque changement d’état et les événements autour. La réponse vient du registre. Lorsque le registre ne le dit vraiment pas, il vous le dira au lieu d’inventer une raison.',
      },
      {
        question: 'Y a-t-il une file plus rapide si je paie ?',
        answer: 'Non. Un paiement cassé est plus urgent qu’un gros compte, et une file prioritaire qui inverse ces deux-là vend la mauvaise chose.',
      },
    ],
    articleSlug: 'support-et-assistance-explique',
    article: `Toutes les équipes de support finissent par recevoir la même question de leur propre direction : pourquoi ne pouvez-vous pas simplement corriger cela ?

Un client est contrarié. Le montant est petit. Le conseiller voit le problème. Lui donner un bouton qui ajuste le solde mettrait fin à l’appel en trente secondes.

C’est l’outil le plus tentant à construire, et il ne devrait pas exister.

## Ce que ce bouton coûte

**Il peut être braqué sur vous.** Un conseiller qui peut déplacer des soldes est une cible. L’ingénierie sociale n’attaque pas les systèmes ; elle attaque des personnes qui ont des permissions, sous pression, et qui veulent être utiles.

**Il cache le vrai problème.** Si un défaut sous-paie des clients et que les conseillers les recréditent discrètement, le défaut n’est jamais trouvé. Il est payé, invisiblement, sur la bonne volonté.

**Il détruit les livres.** Une plateforme dont les soldes sont modifiables ne peut pas prouver ce qu’elle doit. Ni à un régulateur, ni à un auditeur, ni finalement à elle-même.

## Tout lire, ne rien changer

Le support peut ici voir le grand livre, le paiement, chaque tentative, chaque changement d’état, et le journal d’événements chaîné par empreinte autour.

Il ne peut pas fixer un solde — et pas à cause d’un indicateur de permission qui pourrait être changé un mauvais jour. Il ne peut pas parce que **les soldes ne sont pas stockés**. Un solde est la somme de ses écritures. Il n’y a aucun nombre à fixer.

## Alors que se passe-t-il quand on vous doit réellement de l’argent

Une écriture. Sous les règles ordinaires d’autorité et de quatre yeux, avec un motif enregistré et — pour tout ce qui est significatif — une seconde personne qui approuve.

C’est plus lent qu’un bouton. C’est aussi auditable, réversible et attribuable, ce que le bouton n’a jamais été.

## La réponse vient du registre

Quand vous demandez où est parti votre paiement, le conseiller lit ce qui s’est passé : les tentatives, le rail, les changements d’état, les horodatages.

Pas une estimation. Pas *c’est probablement encore en traitement*. Et lorsque le registre ne le dit vraiment pas, on doit vous le dire — un honnête *nous ne savons pas encore, voici ce que nous faisons* vaut mieux qu’une supposition assurée qui s’avère fausse.

## Chaque action porte un nom

Les actions administratives sont écrites dans la piste d’audit sous le nom propre du conseiller.

Cela vous protège, et cela le protège : un conseiller qui a bien agi a une trace qui le prouve.

## Ce que cela coûte

Rien, et il n’y a pas de file prioritaire payante. Un paiement cassé est plus urgent qu’un gros compte, et tout système qui inverse ces deux-là optimise pour le mauvais client.`,
  },

  'bulk-payouts': {
    name: 'Versements en masse',
    tagline: 'Payer cent personnes sans une mauvaise soirée.',
    headline: 'Payer beaucoup de monde à la fois, sans payer personne deux fois',
    excerpt:
      'Les versements en masse échouent dans deux directions : tout le fichier s’arrête à cause d’une ligne fautive, ou la reprise repaie les bonnes lignes. Valider d’abord et rendre compte ligne par ligne supprime les deux.',
    usp: 'Un fichier de versements validé avant toute approbation, approuvé comme un lot, et qui rend compte ligne par ligne — pour qu’une mauvaise ligne ne fasse pas échouer la paie et ne soit pas payée deux fois à la reprise.',
    audience: 'Employeurs qui font la paie, ONG qui distribuent des allocations, coopératives qui paient leurs membres, plateformes qui paient leurs vendeurs.',
    problem:
      'Un fichier de deux cents paiements échoue soit entièrement sur une ligne malformée, soit partiellement en laissant quelqu’un devoir devinner quelle moitié relancer — et relancer la mauvaise moitié paie des gens deux fois.',
    how: [
      'Téléversez le fichier ; il est validé et les erreurs sont signalées avant toute approbation.',
      'Corrigez les lignes fautives et téléversez à nouveau, ou continuez sans elles.',
      'Approuvez le lot ; l’approbation est un acte délibéré, distinct du téléversement.',
      'Le lot s’exécute et rend compte ligne par ligne : payé, échoué, avec le motif.',
    ],
    proof: [
      'Le fichier est validé avant approbation : les erreurs sont trouvées alors que rien n’a bougé.',
      'Les résultats sont par ligne : un échec est attribuable à une ligne plutôt qu’au fichier.',
      'Approuver est distinct de téléverser : personne ne paie deux cents personnes en appuyant une fois sur le mauvais bouton.',
      'Un lot a un nombre de lignes borné et une disposition de colonnes documentée : un fichier est conforme ou rejeté avec un motif.',
      'Les événements de lot sont publiés : un système de paie peut réagir au résultat au lieu d’interroger une boîte de réception.',
    ],
    cost: 'Les versements sont tarifés individuellement au tarif ordinaire du rail ; il n’y a aucun frais distinct pour les envoyer en lot.',
    faq: [
      {
        question: 'Une ligne a échoué. Dois-je relancer le fichier ?',
        answer:
          'Non — et c’est l’erreur qui cause les doubles paiements. Les résultats sont rendus ligne par ligne : vous ne relancez que les lignes qui ont échoué. Le fichier n’est pas un objet tout ou rien.',
      },
      {
        question: 'Qui peut approuver un lot ?',
        answer:
          'Approuver est une action distincte du téléversement : la personne qui prépare la paie n’est pas forcément celle qui la libère. Pour la plupart des organisations, cette séparation est tout l’intérêt.',
      },
      {
        question: 'Que se passe-t-il si mon fichier est erroné ?',
        answer: 'On vous dit quelles lignes et pourquoi, avant toute approbation et avant que le moindre argent ne bouge. Corrigez-les et téléversez à nouveau, ou continuez sans elles.',
      },
    ],
    articleSlug: 'versements-en-masse-explique',
    article: `Payer deux cents personnes d’un coup comporte deux modes de défaillance classiques, et la plupart des systèmes parviennent à avoir les deux.

## Défaillance une : tout ou rien

La ligne 147 contient un numéro de téléphone malformé. Le fichier est rejeté.

Personne n’est payé. Nous sommes le 28. Le responsable financier a désormais une soirée devant lui, et deux cents personnes en ont une pire.

## Défaillance deux : la reprise

Le fichier réussit partiellement. Cent quatre-vingts personnes sont payées, vingt ne le sont pas, et le rapport dit *terminé avec des erreurs*.

Quelqu’un doit maintenant déterminer lesquelles des vingt. S’il se trompe et relance tout le fichier, cent quatre-vingts personnes sont payées **deux fois** — et récupérer un trop-payé auprès de quelqu’un qui l’a déjà dépensé n’est pas un problème technique, c’est une série de conversations difficiles.

## Valider avant toute approbation

Le fichier est contrôlé au téléversement, avant l’approbation et avant que rien ne bouge.

Les erreurs sont signalées avec la ligne et le motif. Corrigez-les et téléversez à nouveau, ou continuez sans elles. C’est une correction de deux minutes à un bureau plutôt qu’un incident à vingt heures.

## L’approbation est un acte distinct

Téléverser et approuver sont des actions différentes : personne ne paie deux cents personnes en cliquant une fois sur la mauvaise chose.

Pour la plupart des organisations, c’est aussi le contrôle qu’elles veulent réellement : la personne qui prépare la paie n’est pas celle qui la libère.

## Des résultats par ligne

Chaque ligne rend compte de son propre résultat : payée, ou échouée avec un motif.

Relancer veut donc dire relancer **les lignes qui ont échoué** — pas le fichier. Le mode de défaillance du double paiement ne se présente simplement pas, parce que personne n’a de raison de renvoyer un lot en bloc.

## Des événements, pas des boîtes de réception

Les résultats de lot sont publiés comme événements : un système de paie peut y réagir.

Personne ne devrait avoir à rafraîchir une page pour savoir si son personnel a été payé.

## Ce que cela coûte

Les versements sont tarifés individuellement au tarif ordinaire du rail. Il n’y a aucune surcharge pour les envoyer ensemble.`,
  },

  subscriptions: {
    name: 'Abonnements et facturation récurrente',
    tagline: 'Des revenus récurrents, sans piéger personne.',
    headline: 'Une facturation récurrente dont on n’a pas à se battre pour sortir',
    excerpt:
      'Les abonnements échouent deux fois : un paiement qui rebondit perd un client qui voulait rester, et une résiliation qui ne marche pas en perd un pour toujours. Les relances corrigent la première ; une résiliation honnête évite la seconde.',
    usp: 'Un prélèvement récurrent sur un mandat que le client a confirmé, avec des relances selon un calendrier publié et une résiliation qui arrête réellement l’argent.',
    audience: 'Toute entité qui facture les mêmes clients de façon répétée : logiciels, écoles, salles de sport, assurance, contrats de service, associations.',
    problem:
      'Un renouvellement échoué met généralement fin à un abonnement que le client voulait garder, et une résiliation difficile à mener transforme un client parti en client en colère qui en parle autour de lui.',
    how: [
      'Le client confirme un mandat ; cette confirmation est le fondement du prélèvement.',
      'Les factures sont émises selon le calendrier du plan et encaissées depuis le portefeuille.',
      'Un prélèvement échoué entre en relance et est réessayé selon un calendrier publié.',
      'La résiliation arrête le prochain prélèvement — depuis le côté du client, pas seulement le vôtre.',
    ],
    proof: [
      'Le prélèvement repose sur un mandat que le client a confirmé, pas sur un numéro de carte conservé au dossier.',
      'Un prélèvement échoué est réessayé selon un calendrier de relance publié plutôt qu’abandonné au premier échec.',
      'Les événements du cycle de vie — créé, résilié, facture payée, paiement échoué — sont publiés : votre système sait sans interroger.',
      'La consommation peut être enregistrée contre un abonnement là où un plan est facturé à l’usage plutôt qu’au forfait.',
    ],
    cost: 'Les abonnements portent le tarif ordinaire sur les paiements qu’ils encaissent. Il n’y a aucun frais distinct pour le calendrier.',
    faq: [
      {
        question: 'Que se passe-t-il quand un paiement échoue ?',
        answer:
          'Il entre en relance et est réessayé selon un calendrier publié. La plupart des renouvellements échoués sont un problème temporaire de solde et non une décision de partir, et abandonner au premier échec perd des clients qui voulaient rester.',
      },
      {
        question: 'Comment un client résilie-t-il ?',
        answer:
          'Depuis son propre côté, et cela arrête le prochain prélèvement. Une résiliation qui exige de contacter le support, ou un appel pendant les heures de bureau, est un procédé trompeur — elle achète un mois de plus et coûte la relation.',
      },
      {
        question: 'Puis-je facturer à l’usage plutôt qu’au forfait ?',
        answer: 'Oui. La consommation peut être enregistrée contre un abonnement : un plan à l’usage facture ce qui a réellement été consommé.',
      },
    ],
    articleSlug: 'abonnements-et-facturation-recurrente-explique',
    article: `Le revenu récurrent est la forme la plus attirante qu’une entreprise puisse prendre, raison pour laquelle tant d’entreprises le poursuivent jusqu’à se faire détester de leurs clients.

Il y a deux défaillances contre lesquelles il vaut la peine de concevoir, et elles tirent dans des directions opposées.

## La première : renoncer trop tôt

Un renouvellement échoue. Le solde était insuffisant ce matin-là. L’abonnement est résilié, l’accès s’arrête, et un client qui avait pleinement l’intention de continuer à payer est parti.

La plupart des renouvellements échoués ne sont pas des décisions. Ce sont des mardis.

Les **relances** sont la solution : un prélèvement échoué est réessayé selon un calendrier publié plutôt qu’abandonné à la première tentative. Étalés sur quelques jours, la plupart de ces paiements réussissent simplement, et le client n’apprend jamais qu’il y avait un problème.

Ce n’est pas glorieux et c’est la chose au meilleur rendement de toute la facturation récurrente.

## La seconde : ne pas lâcher

La tentation inverse, et bien plus dommageable : rendre la résiliation difficile.

Cacher le bouton. Exiger un appel. Seulement aux heures de bureau. Proposer trois écrans de rétention avant le vrai.

Cela fonctionne, au sens où cela achète un mois de plus. Cela produit aussi un client qui en parle à tout le monde, et qui ne reviendra jamais — et, de plus en plus, un régulateur qui s’y intéresse.

**La résiliation arrête ici le prochain prélèvement, depuis le côté du client.** Pas d’appel, pas de labyrinthe de rétention, pas de ticket de support.

Une entreprise qui ne retient que les clients incapables de trouver la sortie n’a pas de revenu récurrent. Elle a un compte à rebours.

## Un mandat, pas une carte conservée

Le prélèvement repose sur un **mandat que le client a confirmé** — un accord explicite d’être débité selon un calendrier.

C’est autre chose que garder un numéro de carte au dossier en espérant qu’il fonctionne encore. Le client a accepté l’arrangement, peut le voir, et peut y mettre fin.

## Des événements, pour que votre système sache

Créé, résilié, facture payée, paiement échoué — tous publiés comme événements.

Votre produit peut suspendre l’accès quand les relances finissent par échouer, et le rétablir à l’instant où une reprise réussit, sans que personne n’interroge quoi que ce soit.

## Les plans à l’usage

La consommation peut être enregistrée contre un abonnement : un plan qui facture ce qui a été consommé facture ce qui a été consommé.

## Ce que cela coûte

Le tarif ordinaire sur les paiements encaissés. Il n’y a aucun frais pour le calendrier lui-même.`,
  },

  'plugins-and-sdks': {
    name: 'SDK et extensions',
    tagline: 'Partez d’un code qui fonctionne, pas d’une spécification.',
    headline: 'L’intégration la plus rapide est celle que vous n’avez pas à écrire',
    excerpt:
      'L’essentiel d’une intégration est le même à chaque fois : authentification, idempotence, vérification de signature, reprises. Les SDK et une extension de boutique font cette partie, et ils sont construits depuis la même table qui sert les requêtes.',
    usp: 'Des SDK dans trois langages et une extension de boutique générés depuis la même table d’opérations que l’API, pour qu’un SDK ne puisse pas décrire un appel que la plateforme n’a pas.',
    audience: 'Développeurs qui préfèrent livrer cette semaine, et commerçants qui veulent une page de paiement sans embaucher.',
    problem:
      'Chaque intégration réimplémente la même plomberie, et chaque réimplémentation est une nouvelle occasion de se tromper subtilement sur la vérification des notifications, d’une façon que personne ne remarque avant que cela ne compte.',
    how: [
      'Installez le SDK de votre langage, ou l’extension de votre boutique.',
      'L’authentification, l’idempotence et la vérification de signature sont prises en charge pour vous.',
      'Créez une intention et traitez la notification avec des objets typés plutôt que du JSON brut.',
      'Testez contre le bac à sable avec les nombres magiques documentés avant d’approcher un vrai paiement.',
    ],
    proof: [
      'Les SDK sont générés depuis la même table d’opérations qui sert les requêtes : ils ne peuvent pas décrire un appel que la plateforme n’a pas.',
      'La vérification de la signature des notifications est implémentée dans le SDK, là où la plupart des intégrations artisanales se trompent.',
      'L’extension de boutique est livrée dans le dépôt plutôt que distribuée à part : sa version correspond à l’API contre laquelle elle a été construite.',
      'Le SDK Node n’a aucune dépendance : ajouter les paiements n’ajoute pas une chaîne d’approvisionnement.',
    ],
    cost: 'Gratuit. Code ouvert dans le dépôt, et aucune licence pour les utiliser.',
    faq: [
      {
        question: 'Suis-je obligé d’utiliser un SDK ?',
        answer:
          'Non. L’API est du HTTP simple avec du JSON et elle est documentée entièrement. Les SDK existent pour vous épargner d’écrire une nouvelle fois la vérification de signature, pas pour cacher quoi que ce soit.',
      },
      {
        question: 'Quels langages ?',
        answer: 'Node, PHP et Python, plus une extension WooCommerce pour les boutiques. Le SDK Node n’a délibérément aucune dépendance.',
      },
      {
        question: 'Le SDK va-t-il prendre du retard sur l’API ?',
        answer:
          'Il est généré depuis la même table d’opérations que celle qui sert l’API : il ne peut pas décrire un appel qui n’existe pas. Lorsqu’une toute nouvelle capacité n’a pas encore atteint un SDK, l’appel brut fonctionne toujours.',
      },
    ],
    articleSlug: 'sdk-et-extensions-explique',
    article: `Regardez deux intégrations de paiement quelconques et l’essentiel du code est identique.

L’authentification. Les clés d’idempotence. La vérification de signature. Les reprises avec temporisation. La traduction des erreurs vers quelque chose que votre application comprend.

Rien de cela n’est votre produit. Tout cela doit être juste.

## La partie qui est toujours fausse

La vérification de la signature des notifications est l’endroit où les intégrations écrites à la main échouent, et elles échouent en silence.

Erreurs courantes, toutes observées en production : comparer des signatures avec une comparaison de chaînes normale au lieu d’une comparaison à temps constant ; vérifier contre le corps analysé plutôt que contre les octets bruts ; oublier de contrôler l’horodatage, ce qui laisse le rejeu grand ouvert ; contrôler l’horodatage mais ne jamais rejeter dessus.

Chacune de ces erreurs produit une intégration qui fonctionne parfaitement en test et qui est fausse d’une façon qui ne compte que le jour où quelqu’un vous attaque.

Le SDK le fait correctement, une fois.

## Généré depuis la même table

Les SDK sont générés depuis la même table d’opérations qui sert les requêtes et produit la documentation.

Un SDK **ne peut donc pas** décrire un appel que la plateforme n’a pas. Ce n’est pas une surcouche maintenue à la main qui dérive lentement derrière l’API — c’est un autre rendu de la même chose.

Lorsque quelque chose de tout neuf n’a pas encore atteint un SDK, l’appel brut fonctionne toujours. Le SDK est une commodité, jamais un péage.

## Aucune dépendance

Le SDK Node n’en a aucune.

Ajouter les paiements à votre projet ne devrait pas ajouter une chaîne d’approvisionnement, une série mensuelle d’avis de sécurité, et une montée de version à planifier. Moins vous installez de choses pour encaisser, moins il y a de choses qui peuvent mal tourner d’une façon que vous n’avez pas choisie.

## Pour les boutiques

L’extension WooCommerce est livrée dans le dépôt plutôt que publiée à part : sa version correspond à l’API contre laquelle elle a été construite.

Un commerçant l’installe, saisit une clé, et encaisse. Aucun développeur requis dans le cas courant.

## Testez d’abord les échecs

Chaque SDK fonctionne contre le bac à sable, et le bac à sable publie des nombres magiques pour des issues précises — y compris un dépassement de délai qui réussit ensuite.

Écrivez votre gestionnaire contre celui-là d’abord. C’est le cas qui trouvera le défaut dans votre logique de reprise, et il est beaucoup moins coûteux à trouver un mardi après-midi que pendant votre premier week-end chargé.

## Ce que cela coûte

Rien. Code ouvert dans le dépôt, pas de licence.`,
  },
};
