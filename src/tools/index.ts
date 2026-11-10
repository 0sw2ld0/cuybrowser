import type { AnyTool } from "../core/registry.js";
import click from "./click.js";
import confirm from "./confirm.js";
import console_messages from "./console_messages.js";
import evaluate from "./evaluate.js";
import find from "./find.js";
import get_text from "./get_text.js";
import handle_dialog from "./handle_dialog.js";
import handoff from "./handoff.js";
import policy_show from "./policy_show.js";
import upload_file from "./upload_file.js";
import { back, forward, reload } from "./history.js";
import hover from "./hover.js";
import navigate from "./navigate.js";
import network_requests from "./network_requests.js";
import press_key from "./press_key.js";
import screenshot from "./screenshot.js";
import scroll from "./scroll.js";
import select_option from "./select_option.js";
import snapshot from "./snapshot.js";
import start from "./start.js";
import status from "./status.js";
import stop from "./stop.js";
import tab_close from "./tab_close.js";
import tab_new from "./tab_new.js";
import tab_select from "./tab_select.js";
import tabs_list from "./tabs_list.js";
import type_ from "./type.js";
import wait_for from "./wait_for.js";
import viewport from "./viewport.js";

export const tools: readonly AnyTool[] = [
  start,
  stop,
  status,
  tabs_list,
  tab_new,
  tab_select,
  tab_close,
  navigate,
  back,
  forward,
  reload,
  wait_for,
  handoff,

  viewport,
  snapshot,
  get_text,
  find,
  screenshot,
  console_messages,
  network_requests,
  click,
  type_,
  select_option,
  press_key,
  hover,
  scroll,
  upload_file,
  handle_dialog,
  evaluate,
  confirm,
  policy_show,
];
