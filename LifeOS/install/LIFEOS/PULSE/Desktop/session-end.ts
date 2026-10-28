/**
 * End a session only after the person confirms. Both ways of ending one (the End session button and the native
 * Close Session shortcut, Cmd+W) go through here, because ending kills the shell and every program in it.
 * `ask` shows the native Keep running / End session dialog and resolves true only for End session.
 */
export async function endWithConfirmation(
  item:{title:string},
  ask:(message:string,detail:string)=>Promise<boolean>,
  end:()=>Promise<void>,
):Promise<boolean>{
  const confirmed=await ask(`End “${item.title}”?`,'This ends its shell and any programs running in it. Closing the Pulse window instead keeps everything running.');
  if(!confirmed)return false;
  await end();
  return true;
}
