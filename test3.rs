mod foo {
    #[macro_export]
    macro_rules! bar { () => {} }
    pub use bar;
}
fn main() {
    foo::bar!();
}
