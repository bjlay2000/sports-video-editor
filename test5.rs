#[macro_export]
macro_rules! bar { () => {} }
use bar;
fn main() { bar!(); }
