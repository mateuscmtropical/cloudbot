// Every text the join matches, in English and Portuguese. Google changes the Meet pages from time to time,
// so update these when a join stops working. They match the element names and the visible text of the page.

// The guest name field in the lobby.
const NAME_FIELD_PATTERN = /your name|seu nome|qual [ée] o seu nome/i;
// Camera and microphone buttons say "Turn off" while the device is on.
const CAMERA_ON_PATTERN = /^(turn off camera|desativar c[âa]mera)/i;
const MICROPHONE_ON_PATTERN = /^(turn off microphone|desativar microfone)/i;
// Ask to join for a guest, Join now for a signed in account.
const JOIN_PATTERN = /^(ask to join|join now|pedir para participar|participar agora)/i;
// Only shown inside the call.
const LEAVE_CALL_PATTERN = /^(leave call|sair da chamada)/i;
// Meet shows this after it refuses a knock.
const REFUSED_PATTERN = /you can.t join this video call|voc[êe] n[ãa]o pode participar desta videochamada/i;
// Meet shows this while the host decides.
const WAITING_PATTERN = /asking to be let in|please wait until a meeting host|pedindo para participar|aguarde at[ée] que um anfitri[ãa]o|solicitando (para )?participar/i;

export { CAMERA_ON_PATTERN, JOIN_PATTERN, LEAVE_CALL_PATTERN, MICROPHONE_ON_PATTERN, NAME_FIELD_PATTERN, REFUSED_PATTERN, WAITING_PATTERN };
