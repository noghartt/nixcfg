import Graphics.X11.ExtraTypes.XF86 

import qualified Data.Map as M

import XMonad

import XMonad.Hooks.EwmhDesktops ( ewmh )
import XMonad.Hooks.ManageDocks ( docks, avoidStruts )

import XMonad.Layout.Fullscreen
import XMonad.Layout.ShowWName
import XMonad.Layout.NoBorders ( smartBorders, noBorders )
import XMonad.Layout.HintedGrid
import XMonad.Layout.ThreeColumns

import XMonad.Util.Run

import qualified XMonad.StackSet as W

main = xmonad
     $ fullscreenSupport
     $ docks
     $ ewmh defaults

defaults = def {
  -- stuffs
  terminal    = myTerminal,
  modMask     = myModMask,
  workspaces  = myWorkspaces,

  -- border stuffs
  borderWidth = myBorderWidth,
  normalBorderColor = myNormalBorderColor,
  focusedBorderColor = myFocusedBorderColor,
  
  -- key bindings
  keys = myKeys,

  -- hooks
  logHook         = myLogHook,
  handleEventHook = myEventHook,
  startupHook     = myStartupHook,
  layoutHook      = showWName' myShowWNameTheme myLayoutHook
}

myTerminal = "alacritty"
myModMask = mod4Mask

myFocusedBorderColor = "#f2e202"
myNormalBorderColor = "#3d3d3d"
myBorderWidth = 2

myLogHook = return ()
myEventHook = mempty
myStartupHook = return ()

myWorkspaces = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]

myKeys conf@(XConfig { XMonad.modMask = modm }) = M.fromList $
  -- launching terminal
  [ ((modm .|. shiftMask, xK_Return), spawn $ XMonad.terminal conf)

  -- restart xmonad and recompile it
  , ((modm, xK_q), spawn "xmonad --recompile; xmonad --restart")

  -- run dmenu
  , ((modm, xK_p), spawn "exe=`dmenu_path | dmenu` && eval \"exec $exe\"")
  
  -- audio things
  , ((0, xF86XK_AudioLowerVolume), spawn "pactl set-sink-volume 0 -5%")
  , ((0, xF86XK_AudioRaiseVolume), spawn "pactl set-sink-volume 0 +5%")
  , ((0, xF86XK_AudioMute), spawn "pactl set-sink-mute 0 toggle")
  , ((0, xF86XK_AudioPlay), spawn "playerctl play-pause")
  , ((0, xF86XK_AudioPrev), spawn "playerctl previous")
  , ((0, xF86XK_AudioNext), spawn "playerctl next")

  -- SCREENSHOT \O/
  , ((0, xK_Print), spawn "flameshot gui")

  -- layouts
  , ((modm, xK_space), sendMessage NextLayout)

  , ((modm, xK_j), windows W.focusDown)
  , ((modm, xK_k), windows W.focusUp)
  , ((modm, xK_m), windows W.focusMaster)

  , ((modm .|. shiftMask, xK_j), windows W.swapDown)
  , ((modm .|. shiftMask, xK_k), windows W.swapUp)

  , ((modm .|. shiftMask, xK_h), sendMessage Shrink)
  , ((modm .|. shiftMask, xK_l), sendMessage Expand)

  , ((modm, xK_t), withFocused $ windows . W.sink) -- fix a float window

  , ((modm .|. shiftMask, xK_c), kill)
  ]
  ++
  [((m .|. modm, k), windows $ f i)
    | (i, k) <- zip (XMonad.workspaces conf) [xK_1 .. xK_9]
    , (f, m) <- [(W.greedyView, 0), (W.shift, shiftMask)]]

myLayoutHook
  = smartBorders
  $ avoidStruts 
  $ noBorders Full
    ||| tiled
    ||| Mirror tiled 
    ||| ThreeColMid nmaster delta ratio
    ||| Grid False
  where
    -- default tiling algorithm partitions the screen into two panes
    tiled = Tall nmaster delta ratio

    -- The default number of windows in the master pane
    nmaster = 1

    -- Default proportion of screen occupied by master pane
    ratio = 1 / 2

    -- Percent of screen to increment by when resizing panes
    delta = 3 / 100

myShowWNameTheme :: SWNConfig
myShowWNameTheme =
  def
    { swn_font = "xft:FiraCode Nerd Font:bold:size=60",
      swn_fade = 1.0,
      swn_bgcolor = "%bg%",
      swn_color = "%fg%"
    }
